import express from 'express';
import dotenv from 'dotenv';
import multer from 'multer';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import QRCode from 'qrcode';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// Configura o dotenv para ler o arquivo .env
dotenv.config();

const app = express();
// Necessário pra identificar o IP real do cliente atrás do proxy da Vercel/cloudflared
// (senão o rate limiting abaixo trataria todo mundo como se viesse do mesmo IP).
app.set('trust proxy', 1);

// Guarda o corpo bruto (antes do parse) em req.rawBody — necessário para
// recalcular o HMAC da assinatura do webhook da Meta.
app.use(express.json({ limit: '50mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());

// Rate limiting básico — protege contra flood/força bruta.
// Limite geral generoso de propósito: várias pessoas da clínica usam o sistema
// atrás do mesmo IP do escritório, e o polling de notificações (a cada 10s)
// já soma ~90 requisições/15min só de uma aba aberta.
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    // 2000 parecia generoso mas na prática cada aba aberta já soma sozinha uns 450-550
    // requisições/15min só de polling de fundo (kanban a cada 5s, chat a cada 6s, heartbeat
    // a cada 30s, notificações a cada 10s) — com a clínica toda atrás do mesmo IP do
    // escritório, isso estourava o limite rápido mesmo sem nenhum uso "pesado" de verdade.
    limit: 8000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Muitas requisições. Tente novamente em alguns minutos.' }
});
app.use('/api', apiLimiter);

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Muitas tentativas de login. Tente novamente em alguns minutos.' }
});

const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false
});

// O link curto de campanha (/r/:slug) é público de propósito (QR code em panfleto), mas
// fica fora do /api então não pegava o apiLimiter geral — sem isso, dava pra martelar ele
// sem limite nenhum só pra poluir o contador de "scans" de uma campanha.
const shortLinkLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Muitas requisições. Tente novamente em alguns instantes.' }
});

// Serve a pasta atual como arquivos estáticos (Frontend) apenas localmente
if (!process.env.VERCEL) {
    app.use(express.static(process.cwd()));
}

// ==========================================
// NORMALIZAÇÃO DE TELEFONE (evita leads duplicados pro mesmo número)
// ==========================================
// Formato canônico: só dígitos, sempre com DDI 55 e sempre com o 9º dígito do
// celular (ex: 5561996351852). Sem isso, o mesmo número pode ficar salvo de
// formas diferentes (com/sem 55, com/sem o 9) e virar leads separados.
function normalizePhoneBR(raw) {
    let digits = String(raw || '').replace(/\D/g, '');
    if (!digits) return '';
    if (!digits.startsWith('55')) digits = '55' + digits;
    // 55 + DDD(2) + local de 8 dígitos → celular sem o 9º dígito, adiciona
    if (digits.length === 12) {
        const ddd = digits.slice(2, 4);
        const local = digits.slice(4);
        digits = '55' + ddd + '9' + local;
    }
    return digits;
}

// Todas as formas equivalentes que esse número pode estar salvo no banco
// (dados antigos podem não estar no formato canônico).
function phoneVariants(raw) {
    const canonical = normalizePhoneBR(raw);
    const variants = new Set();
    if (canonical) variants.add(canonical);

    const rawDigits = String(raw || '').replace(/\D/g, '');
    if (rawDigits) variants.add(rawDigits);

    if (canonical.length === 13) {
        const ddd = canonical.slice(2, 4);
        const local9 = canonical.slice(4);
        if (local9.startsWith('9')) {
            const sem9 = '55' + ddd + local9.slice(1);
            variants.add(sem9);
            variants.add(sem9.replace(/^55/, ''));
        }
    }
    variants.add(canonical.replace(/^55/, ''));

    return Array.from(variants).filter(Boolean);
}

// ==========================================
// AUTENTICAÇÃO (SESSÃO VIA COOKIE JWT)
// ==========================================
// Protege toda a API por padrão. Só ficam de fora:
// - /api/login (é como a sessão começa a existir)
// - /api/ping (health check)
// - /api/whatsapp/webhook (chamado pelos servidores da Meta, não pelo navegador logado;
//   o GET usa o verify_token do handshake, o POST precisa de validação de assinatura
//   HMAC própria — ver observação no handler abaixo)
// Montado via app.use('/api', requireAuth) — dentro do middleware, req.path já vem
// SEM o prefixo /api (o Express remove o trecho do mount point), por isso a lista
// abaixo usa os caminhos relativos ao mount.
const PUBLIC_API_PATHS = new Set(['/login', '/ping', '/whatsapp/webhook']);

function requireAuth(req, res, next) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();

    const token = req.cookies && req.cookies.crm_token;
    if (!token) {
        return res.status(401).json({ error: 'Não autenticado.' });
    }

    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
        return next();
    } catch (e) {
        return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    }
}

app.use('/api', requireAuth);

app.get('/api/ping', (req, res) => res.send('pong3'));

// ==========================================
// WHATSAPP CLOUD API ROUTES
// ==========================================

// Valida a assinatura HMAC-SHA256 que a Meta envia no header X-Hub-Signature-256,
// calculada sobre o corpo bruto da requisição com o App Secret. Só passa quem
// realmente conhece o App Secret — bloqueia payloads forjados.
function isValidMetaSignature(req) {
    const appSecret = process.env.META_APP_SECRET;
    const signatureHeader = req.get('x-hub-signature-256');

    if (!appSecret || !signatureHeader || !req.rawBody) return false;

    const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(req.rawBody).digest('hex');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const receivedBuffer = Buffer.from(signatureHeader, 'utf8');

    if (expectedBuffer.length !== receivedBuffer.length) return false;
    return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

// 1. Webhook Verification (Meta Challenge)
app.get('/api/whatsapp/webhook', (req, res) => {
    const verify_token = process.env.META_WA_VERIFY_TOKEN;
    
    let mode = req.query["hub.mode"];
    let token = req.query["hub.verify_token"];
    let challenge = req.query["hub.challenge"];

    if (mode && token) {
        if (mode === "subscribe" && token === verify_token) {
            console.log("WEBHOOK_VERIFIED");
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    } else {
        res.status(400).send("Bad Request");
    }
});

// 2. Receive Messages from WhatsApp
app.post('/api/whatsapp/webhook', webhookLimiter, async (req, res) => {
    if (!isValidMetaSignature(req)) {
        console.error('Webhook do WhatsApp: assinatura ausente ou inválida — requisição rejeitada.');
        return res.sendStatus(403);
    }

    let body = req.body;

    // Log mínimo — o payload completo não é mais gravado no disco nem no console:
    // ele contém números de telefone e conteúdo de mensagem reais de paciente.
    console.log('Webhook do WhatsApp recebido:', body.object || 'objeto desconhecido');

    if (body.object) {
        if (
            body.entry &&
            body.entry[0].changes &&
            body.entry[0].changes[0] &&
            body.entry[0].changes[0].value.messages &&
            body.entry[0].changes[0].value.messages[0]
        ) {
            let message_obj = body.entry[0].changes[0].value.messages[0];
            let from = message_obj.from;
            let msg_id = message_obj.id;

            // Usa o horário real do envio (vem no próprio payload da Meta) em vez
            // da hora que o webhook chegou aqui — se a Meta reentregar uma mensagem
            // atrasada (ex.: servidor estava fora do ar), sem isso ela aparecia com
            // a data de hoje mesmo tendo sido mandada ontem.
            const msgTimestamp = message_obj.timestamp
                ? new Date(parseInt(message_obj.timestamp, 10) * 1000).toISOString().slice(0, 19).replace('T', ' ')
                : new Date().toISOString().slice(0, 19).replace('T', ' ');

            let msg_body = "";
            const msg_type = message_obj.type;
            
            if (msg_type === "text") {
                msg_body = message_obj.text ? message_obj.text.body : "";
            } else if (msg_type === "image") {
                const mediaId = message_obj.image.id;
                const caption = message_obj.image.caption || "";
                msg_body = `[FILE:Imagem.jpg]/api/whatsapp/media/${mediaId}.jpg${caption ? `[CAPTION:${caption}]` : ''}`;
            } else if (msg_type === "audio" || msg_type === "voice") {
                const audioObj = message_obj.audio || message_obj.voice;
                const mediaId = audioObj.id;
                msg_body = `[FILE:Áudio.ogg]/api/whatsapp/media/${mediaId}.ogg`;
            } else if (msg_type === "video") {
                const mediaId = message_obj.video.id;
                const caption = message_obj.video.caption || "";
                msg_body = `[FILE:Vídeo.mp4]/api/whatsapp/media/${mediaId}.mp4${caption ? `[CAPTION:${caption}]` : ''}`;
            } else if (msg_type === "document") {
                const mediaId = message_obj.document.id;
                const fileName = message_obj.document.filename || "Documento";
                const ext = fileName.includes('.') ? fileName.split('.').pop() : 'bin';
                msg_body = `[FILE:${fileName}]/api/whatsapp/media/${mediaId}.${ext}`;
            } else if (msg_type === "sticker") {
                const mediaId = message_obj.sticker.id;
                msg_body = `[FILE:Figurinha.webp]/api/whatsapp/media/${mediaId}.webp`;
            } else if (msg_type === "reaction") {
                const emoji = message_obj.reaction.emoji || "";
                msg_body = `[Reagiu com: ${emoji}]`;
            } else if (msg_type === "location") {
                const loc = message_obj.location;
                const mapsUrl = `https://www.google.com/maps?q=${loc.latitude},${loc.longitude}`;
                msg_body = `📍 [Localização: ${loc.name || loc.address || 'Ver no mapa'}]\nLink: ${mapsUrl}`;
            } else if (msg_type === "contacts") {
                const contact = message_obj.contacts && message_obj.contacts[0];
                const name = contact ? (contact.name.formatted_name || contact.name.first_name || "Contato") : "Contato";
                const phone = contact && contact.phones && contact.phones[0] ? contact.phones[0].phone : "";
                msg_body = `👤 [Contato: ${name} ${phone ? `- ${phone}` : ''}]`;
            } else {
                msg_body = `[Mensagem do tipo: ${msg_type}]`;
            }

            // Extrai o nome do perfil do WhatsApp
            let profileName = "Lead WhatsApp";
            if (body.entry[0].changes[0].value.contacts && body.entry[0].changes[0].value.contacts[0]) {
                profileName = body.entry[0].changes[0].value.contacts[0].profile?.name || profileName;
            }

            console.log(`Mensagem recebida de ${from}: ${msg_body}`);
            
            try {
                let referral = null;
                let origemLead = 'WhatsApp Orgânico';
                
                if (message_obj.referral) {
                    referral = JSON.stringify(message_obj.referral);
                    origemLead = 'Meta Ads';
                    if (message_obj.referral.headline) {
                        origemLead = `Meta Ads: ${message_obj.referral.headline}`;
                    }
                } else if (msg_type === "text" && msg_body) {
                    const matchedCampaign = await matchTriggerCampaign(msg_body);
                    if (matchedCampaign) {
                        origemLead = matchedCampaign.nome;
                    }
                }

                const quoted_id = message_obj.context ? message_obj.context.id : null;

                // 1. Salva a mensagem no histórico do chat (incluindo o campo referral e quoted_id)
                await queryD1(
                    'INSERT INTO wa_messages (id, phone, direction, message, status, referral, quoted_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [msg_id, from, 'in', msg_body, 'received', referral, quoted_id, msgTimestamp]
                );

                // 2. Verifica se o lead já existe no Kanban — casa qualquer forma equivalente
                //    do número (com/sem 55, com/sem o 9º dígito), não só substring.
                const variants = phoneVariants(from);
                const placeholders = variants.map(() => '?').join(', ');
                const leadRows = await queryD1(`SELECT id, nome FROM leads WHERE telefone IN (${placeholders})`, variants);

                // 3. Se não existe, cria um novo Lead no Kanban na coluna Novos (telefone sempre no formato canônico)
                if (!leadRows || leadRows.length === 0) {
                    const newLeadId = Date.now().toString();

                    let notasAdicionais = '';
                    if (message_obj.referral) {
                        notasAdicionais = `[Lead de Anúncio Meta]\nTítulo do Anúncio: ${message_obj.referral.headline || ''}\nDescrição: ${message_obj.referral.body || ''}\nLink: ${message_obj.referral.source_url || ''}\n\n`;
                    }

                    await queryD1(
                        'INSERT INTO leads (id, nome, telefone, origem, born, owner_id, column_id, fb_click_id, email, notas) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        [newLeadId, profileName, normalizePhoneBR(from), origemLead, '', '', 'col-entrada', '', '', notasAdicionais]
                    );
                    console.log(`Novo lead criado a partir do WhatsApp: ${profileName} (${from}) - Origem: ${origemLead}`);
                } else if (profileName !== 'Lead WhatsApp') {
                    // O nome do perfil nem sempre vem na primeira mensagem (depende de privacidade/tipo de mensagem).
                    // Se o lead ainda está com o nome genérico e uma mensagem posterior trouxe o nome real, atualiza.
                    const existingLead = leadRows[0];
                    if (!existingLead.nome || existingLead.nome === 'Lead WhatsApp') {
                        await queryD1('UPDATE leads SET nome = ? WHERE id = ?', [profileName, existingLead.id]);
                        console.log(`Nome do lead atualizado a partir do WhatsApp: ${profileName} (${from})`);
                    }
                }
            } catch(e) {
                console.error("Erro ao processar webhook no DB:", e);
            }
        }
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

// 2.5 Proxy Media Requests from Meta
app.get('/api/whatsapp/media/:mediaFile', async (req, res) => {
    const token = process.env.META_WA_ACCESS_TOKEN;
    if (!token) {
        return res.status(500).send("META_WA_ACCESS_TOKEN não configurada.");
    }

    const match = req.params.mediaFile.match(/^(\d+)/);
    if (!match) {
        return res.status(400).send("ID de mídia inválido.");
    }
    const mediaId = match[1];

    try {
        const infoRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!infoRes.ok) {
            return res.status(infoRes.status).send("Erro ao buscar informações da mídia na Meta.");
        }

        const mediaInfo = await infoRes.json();
        const downloadUrl = mediaInfo.url;
        if (!downloadUrl) {
            return res.status(404).send("URL de download da mídia não encontrada.");
        }

        const mediaRes = await fetch(downloadUrl, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!mediaRes.ok) {
            return res.status(mediaRes.status).send("Erro ao baixar a mídia da Meta.");
        }

        res.setHeader('Content-Type', mediaInfo.mime_type || 'application/octet-stream');
        if (mediaInfo.file_size) {
            res.setHeader('Content-Length', mediaInfo.file_size);
        }

        if (mediaRes.body) {
            Readable.fromWeb(mediaRes.body).pipe(res);
        } else {
            res.sendStatus(500);
        }

    } catch (error) {
        console.error("Erro no proxy de mídia:", error);
        res.status(500).send("Erro interno ao processar a mídia.");
    }
});
// Helper para fazer upload de mídia para a API do WhatsApp da Meta
// Converte qualquer áudio gravado no navegador (normalmente WebM/Opus) pro
// formato que o WhatsApp exige pra mostrar como mensagem de voz nativa de
// verdade (bolinha com forma de onda) em vez de anexo genérico: contêiner
// OGG com codec Opus, mono. Sem essa conversão, o WhatsApp ainda toca o
// áudio, mas normalmente como um player de arquivo comum.
async function convertToOggOpus(buffer, inputExt = 'webm') {
    const tmpDir = os.tmpdir();
    const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const inputPath = path.join(tmpDir, `wa-audio-in-${uid}.${inputExt}`);
    const outputPath = path.join(tmpDir, `wa-audio-out-${uid}.ogg`);

    await fs.promises.writeFile(inputPath, buffer);

    try {
        await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                // O WebM gravado pelo navegador não tem a duração real no cabeçalho
                // (pensado pra streaming) — sem "genpts" o ffmpeg herda timestamps
                // incorretos e o áudio final aparece com duração absurda no WhatsApp,
                // fazendo o cliente tratar como arquivo de áudio comum, não voice note.
                .inputOptions(['-fflags', '+genpts'])
                .audioCodec('libopus')
                .audioChannels(1)
                .audioFrequency(16000)
                .audioBitrate('32k')
                .format('ogg')
                .on('error', reject)
                .on('end', resolve)
                .save(outputPath);
        });
        return await fs.promises.readFile(outputPath);
    } finally {
        fs.promises.unlink(inputPath).catch(() => {});
        fs.promises.unlink(outputPath).catch(() => {});
    }
}

async function uploadMediaToMeta(buffer, mimeType, fileName) {
    const phone_id = process.env.META_WA_PHONE_ID;
    const token = process.env.META_WA_ACCESS_TOKEN;
    
    const formData = new FormData();
    formData.append('messaging_product', 'whatsapp');
    
    const blob = new Blob([buffer], { type: mimeType });
    formData.append('file', blob, fileName);

    const response = await fetch(`https://graph.facebook.com/v20.0/${phone_id}/media`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`
        },
        body: formData
    });

    if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error?.message || `Erro no upload da mídia: ${response.statusText}`);
    }

    const result = await response.json();
    return result.id;
}

// 3. Send Message to WhatsApp (Suporta texto e mídias via Base64 do frontend)
app.post('/api/whatsapp/send', async (req, res) => {
    const { to, message, isTemplate, templateName, languageCode, templateParams, quoted_id, isReaction, reactionEmoji, isVoiceRecording } = req.body;
    
    if (!to) {
        return res.status(400).json({ error: "Número de destino (to) é obrigatório." });
    }

    const phone_id = process.env.META_WA_PHONE_ID;
    const token = process.env.META_WA_ACCESS_TOKEN;
    
    if (!phone_id || !token) {
        return res.status(500).json({ error: "Credenciais do WhatsApp não configuradas no servidor." });
    }

    try {
        let result;
        let db_message_body = message;

        // Verificar se a mensagem é um arquivo de mídia (imagem, áudio, vídeo, etc.)
        let isMedia = false;
        let mediaType = ""; // "image", "audio", "video", "document"
        let mediaId = "";
        let fileName = "";
        let captionText = "";

        if (message && (message.startsWith("[FILE:") || message.includes("[FILE:"))) {
            isMedia = true;
            
            // Extrai o nome do arquivo
            const fileMatch = message.match(/\[FILE:(.*?)\]\n?/);
            if (fileMatch) {
                fileName = fileMatch[1];
            }

            // Extrai a legenda se houver
            const captionMatch = message.match(/\[CAPTION:(.*?)\]/s);
            if (captionMatch) {
                captionText = captionMatch[1];
            }

            // Remove os blocos de metadados para pegar apenas os dados base64 (removido o ^ de início de linha para pegar no meio da string)
            let cleanData = message.replace(/\[FILE:.*?\]\n?/, '').replace(/\[CAPTION:.*?\]\n?/, '').trim();
            
            // Se for um encaminhamento de mídia (já possui um caminho local da API)
            const mediaPathMatch = cleanData.match(/\/api\/whatsapp\/media\/([^\./?#]+)/);
            if (mediaPathMatch) {
                mediaId = mediaPathMatch[1];
                const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : 'bin';
                if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) mediaType = "image";
                else if (['mp3', 'ogg', 'wav', 'm4a', 'opus', 'aac'].includes(ext)) mediaType = "audio";
                else if (['mp4', 'mov', 'avi', 'webm', '3gpp'].includes(ext)) mediaType = "video";
                else mediaType = "document";
                console.log(`Encaminhando mídia existente (${mediaType}) com ID: ${mediaId}`);
            } else {
                // Caso padrão: upload de Base64
                const base64Match = cleanData.match(/^data:(.*?);base64,(.*)$/s);
                if (base64Match) {
                    let mimeType = base64Match[1];
                    const base64Data = base64Match[2];
                    let buffer = Buffer.from(base64Data, 'base64');

                    // Determina o tipo de mídia baseado no mime type
                    if (mimeType.startsWith("image/")) mediaType = "image";
                    else if (mimeType.startsWith("audio/")) mediaType = "audio";
                    else if (mimeType.startsWith("video/")) mediaType = "video";
                    else mediaType = "document";

                    // Gravação de voz feita no navegador: converte pro formato de mensagem
                    // de voz nativa do WhatsApp (OGG/Opus) antes de subir pra Meta.
                    if (mediaType === "audio" && isVoiceRecording && mimeType !== 'audio/ogg') {
                        const sourceExt = (mimeType.split('/')[1] || 'webm').split(';')[0];
                        console.log(`Convertendo gravação de voz (${mimeType}) para OGG/Opus... (buffer original: ${buffer.length} bytes)`);

                        // DEBUG TEMPORÁRIO: guarda uma cópia do áudio original e do convertido
                        // pra investigar o erro "áudio não está mais disponível" no WhatsApp.
                        try {
                            const debugDir = path.join(os.tmpdir(), 'wa-audio-debug');
                            await fs.promises.mkdir(debugDir, { recursive: true });
                            await fs.promises.writeFile(path.join(debugDir, `raw-${Date.now()}.${sourceExt}`), buffer);
                        } catch (e) { console.error('Falha ao salvar debug do áudio original:', e); }

                        buffer = await convertToOggOpus(buffer, sourceExt);
                        mimeType = 'audio/ogg; codecs=opus';
                        fileName = 'audio.ogg';

                        console.log(`Conversão concluída: buffer OGG final tem ${buffer.length} bytes.`);
                        try {
                            const debugDir = path.join(os.tmpdir(), 'wa-audio-debug');
                            await fs.promises.writeFile(path.join(debugDir, `converted-${Date.now()}.ogg`), buffer);
                        } catch (e) { console.error('Falha ao salvar debug do áudio convertido:', e); }
                    }

                    // Faz o upload para a Meta
                    console.log(`Fazendo upload de mídia (${mediaType}) para a Meta...`);
                    mediaId = await uploadMediaToMeta(buffer, mimeType, fileName || `file.${mimeType.split('/')[1]}`);
                    console.log(`Upload concluído! Media ID: ${mediaId}`);
                } else {
                    throw new Error("Formato de arquivo base64 ou mídia inválido.");
                }
            }
        }

        // Configura o payload para a API do WhatsApp da Meta
        let data = {
            messaging_product: "whatsapp",
            to: to,
        };

        if (isReaction) {
            data.type = "reaction";
            data.reaction = {
                message_id: quoted_id,
                emoji: reactionEmoji || ""
            };
            db_message_body = `[Reagiu com: ${reactionEmoji || ''}]`;
        } else {
            if (quoted_id) {
                data.context = {
                    message_id: quoted_id
                };
            }

            if (isTemplate) {
                data.type = "template";
                data.template = {
                    name: templateName || "hello_world",
                    language: { code: languageCode || "pt_BR" }
                };
                // Templates com variável no corpo (ex: "Olá {{1}}") exigem um array de
                // parâmetros correspondente — sem isso a Meta rejeita com o erro
                // #132000 "Number of parameters does not match the expected number".
                if (Array.isArray(templateParams) && templateParams.length > 0) {
                    data.template.components = [{
                        type: "body",
                        parameters: templateParams.map(p => ({ type: "text", text: String(p) }))
                    }];
                }
                // O front manda "message: 'template'" só como placeholder pra satisfazer o
                // payload — sem isso, o balão do chat mostrava literalmente a palavra
                // "template" em vez de dizer qual template foi enviado.
                db_message_body = `📋 Template enviado: *${templateName || 'hello_world'}*`;
            } else if (isMedia && mediaId) {
                data.type = mediaType;
                data[mediaType] = {
                    id: mediaId
                };
                if (captionText && (mediaType === "image" || mediaType === "video" || mediaType === "document")) {
                    data[mediaType].caption = captionText;
                }
                // Sem esse campo, o WhatsApp mostra QUALQUER áudio como anexo comum,
                // não importa o formato do arquivo — é ele que faz aparecer como
                // mensagem de voz nativa (bolinha com forma de onda).
                if (mediaType === "audio" && isVoiceRecording) {
                    data.audio.voice = true;
                }
                
                // Formatamos como a mensagem será salva no DB local
                const ext = fileName.includes('.') ? fileName.split('.').pop() : 'bin';
                db_message_body = `[FILE:${fileName}]/api/whatsapp/media/${mediaId}.${ext}${captionText ? `[CAPTION:${captionText}]` : ''}`;
            } else {
                // A assinatura do atendente já é adicionada pelo front-end (getAttendantSignature())
                // antes de chegar aqui. Não duplicar com outra assinatura no backend.
                data.type = "text";
                data.text = { body: message };
                db_message_body = message;
            }
        }

        const response = await fetch(`https://graph.facebook.com/v20.0/${phone_id}/messages`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(data),
        });

        const resultJson = await response.json();
        if (!response.ok) {
            throw new Error(resultJson.error ? resultJson.error.message : "Erro desconhecido na Meta API");
        }

        result = resultJson;

        // Salvar no banco local wa_messages
        try {
            let msg_id = result.messages ? result.messages[0].id : Date.now().toString();
            await queryD1(
                'INSERT INTO wa_messages (id, phone, direction, message, status, quoted_id) VALUES (?, ?, ?, ?, ?, ?)',
                [msg_id, to, 'out', db_message_body, 'sent', quoted_id || null]
            );

            // Registra o envio de template pra permitir bloquear reenvio do mesmo
            // template pro mesmo número em campanhas futuras.
            if (isTemplate && templateName) {
                await queryD1(
                    'INSERT INTO wa_template_sends (phone, template_name) VALUES (?, ?)',
                    [to, templateName]
                );
            }
        } catch(e) {
            console.error("Erro ao salvar mensagem enviada no DB:", e);
        }

        res.status(200).json({ success: true, data: result });
    } catch (error) {
        console.error("Erro ao enviar mensagem WhatsApp:", error.message);
        console.error(error);
        // Repassa o motivo real (ex.: erro da própria Meta) em vez de esconder
        // atrás de "Erro interno do servidor" — sem isso, falhas de template/
        // formato ficavam ilegíveis pra quem está usando o CRM.
        res.status(500).json({ error: error.message || 'Erro interno do servidor.' });
    }
});

// 3.8. Excluir Mensagem do WhatsApp (Localmente e na Meta se for enviada)
app.post('/api/whatsapp/delete-message', async (req, res) => {
    const { message_id } = req.body;
    
    if (!message_id) {
        return res.status(400).json({ error: "ID da mensagem é obrigatório." });
    }

    const phone_id = process.env.META_WA_PHONE_ID;
    const token = process.env.META_WA_ACCESS_TOKEN;

    try {
        // 1. Busca a mensagem no banco para verificar se foi enviada (direction = out)
        const rows = await queryD1('SELECT direction FROM wa_messages WHERE id = ?', [message_id]);
        const msg = rows[0];

        if (msg && msg.direction === 'out' && phone_id && token) {
            try {
                // Tenta revogar na API da Meta
                console.log(`Tentando revogar mensagem ${message_id} na Meta...`);
                const metaRes = await fetch(`https://graph.facebook.com/v20.0/${phone_id}/messages`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        messaging_product: 'whatsapp',
                        status: 'deleted',
                        message_id: message_id
                    })
                });
                const metaJson = await metaRes.json();
                console.log("Resposta da revogação na Meta:", metaJson);
            } catch (err) {
                console.error("Erro ao revogar na API da Meta (prosseguindo com exclusão local):", err.message);
            }
        }

        // 2. Marca a mensagem como apagada no banco de dados local
        await queryD1("UPDATE wa_messages SET message = '🚫 Esta mensagem foi apagada' WHERE id = ?", [message_id]);
        
        res.status(200).json({ success: true });
    } catch (error) {
        console.error("Erro ao excluir mensagem:", error.message);
        console.error(error);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// 4. Listar Chats Recentes (Contatos)
app.get('/api/whatsapp/chats', async (req, res) => {
    try {
        const rows = await queryD1(`
            SELECT phone,
                   MAX(timestamp) as last_interaction,
                   message,
                   direction,
                   SUM(CASE WHEN direction = 'in' AND (status IS NULL OR status != 'read') THEN 1 ELSE 0 END) as unread_count
            FROM wa_messages
            GROUP BY phone
            ORDER BY last_interaction DESC
        `);
        res.json({ success: true, data: rows });
    } catch(e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// Telefones que já receberam um template específico — usado pra não repetir o
// mesmo template pra quem já recebeu em campanhas anteriores.
app.get('/api/whatsapp/template-sends/:templateName', async (req, res) => {
    try {
        const rows = await queryD1(
            'SELECT DISTINCT phone FROM wa_template_sends WHERE template_name = ?',
            [req.params.templateName]
        );
        res.json({ success: true, phones: (rows || []).map(r => r.phone) });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ==========================================
// PREFERÊNCIAS POR CONVERSA (não lido manual, favorito, fixado, arquivado)
// ==========================================
// A chave é o telefone já normalizado pelo front (canonicalPhoneBR) — o mesmo
// número pode ter chegado em variantes diferentes (com/sem o 9º dígito) na
// tabela wa_messages, então o merge com essas preferências é feito no cliente,
// não com um JOIN aqui, pra sempre bater com a versão canônica exibida na lista.
queryD1(`CREATE TABLE IF NOT EXISTS crm_chat_settings (
    phone TEXT PRIMARY KEY,
    is_favorite INTEGER DEFAULT 0,
    is_pinned INTEGER DEFAULT 0,
    is_archived INTEGER DEFAULT 0,
    marked_unread INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});

const CHAT_SETTINGS_FIELDS = ['is_favorite', 'is_pinned', 'is_archived', 'marked_unread'];

app.get('/api/chat-settings', async (req, res) => {
    try {
        const rows = await queryD1('SELECT * FROM crm_chat_settings');
        res.json({ items: rows || [] });
    } catch (e) {
        console.error('Erro ao listar preferências de conversas:', e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

app.patch('/api/chat-settings/:phone', async (req, res) => {
    try {
        const { field, value } = req.body;
        if (!CHAT_SETTINGS_FIELDS.includes(field)) {
            return res.status(400).json({ error: 'Campo inválido.' });
        }
        const phone = req.params.phone;
        const intValue = value ? 1 : 0;

        await queryD1(
            `INSERT INTO crm_chat_settings (phone, ${field}) VALUES (?, ?)
             ON CONFLICT(phone) DO UPDATE SET ${field} = excluded.${field}, updated_at = CURRENT_TIMESTAMP`,
            [phone, intValue]
        );
        res.json({ success: true });
    } catch (e) {
        console.error('Erro ao atualizar preferência de conversa:', e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// Gera as variantes possíveis de um número (com/sem DDI 55, com/sem o 9º dígito
// transicional) pra achar/apagar todas as mensagens de uma conversa, já que o
// mesmo contato pode ter sido salvo em formatos diferentes ao longo do tempo.
function buildPhoneVariants(phone) {
    const digits = phone.replace(/\D/g, '');
    const normalized = digits.startsWith('55') ? digits : '55' + digits;

    const phones = new Set([normalized, digits]);

    if (normalized.length === 13) {
        const local = normalized.slice(4);
        if (local.startsWith('9')) {
            const sem9 = normalized.slice(0, 4) + local.slice(1);
            phones.add(sem9);
            phones.add(sem9.replace(/^55/, ''));
        }
    }
    if (normalized.length === 12) {
        const local = normalized.slice(4);
        const com9 = normalized.slice(0, 4) + '9' + local;
        phones.add(com9);
        phones.add(com9.replace(/^55/, ''));
    }

    return Array.from(phones);
}

// 5. Histórico de Conversa de um Número
app.get('/api/whatsapp/chat/:phone', async (req, res) => {
    try {
        const phonesArr = buildPhoneVariants(req.params.phone);
        const placeholders = phonesArr.map(() => '?').join(', ');

        const rows = await queryD1(`
            SELECT m.*,
                   q.message as quoted_message,
                   q.direction as quoted_direction
            FROM wa_messages m
            LEFT JOIN wa_messages q ON m.quoted_id = q.id
            WHERE m.phone IN (${placeholders})
            ORDER BY m.timestamp ASC
        `, phonesArr);
        res.json({ success: true, data: rows });
    } catch(e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// Apaga o histórico de mensagens de UMA conversa (todas as variantes do número).
app.delete('/api/whatsapp/chat/:phone', async (req, res) => {
    try {
        const phonesArr = buildPhoneVariants(req.params.phone);
        const placeholders = phonesArr.map(() => '?').join(', ');
        await queryD1(`DELETE FROM wa_messages WHERE phone IN (${placeholders})`, phonesArr);
        res.json({ success: true });
    } catch (e) {
        console.error('Erro ao apagar conversa:', e);
        res.status(500).json({ error: 'Erro interno ao apagar conversa.' });
    }
});

// Apaga o histórico de VÁRIAS conversas de uma vez (seleção múltipla no front).
app.delete('/api/whatsapp/chats', async (req, res) => {
    try {
        const { phones } = req.body;
        if (!Array.isArray(phones) || phones.length === 0) {
            return res.status(400).json({ error: 'Informe ao menos um número (phones[]).' });
        }
        for (const phone of phones) {
            const variants = buildPhoneVariants(String(phone));
            const placeholders = variants.map(() => '?').join(', ');
            await queryD1(`DELETE FROM wa_messages WHERE phone IN (${placeholders})`, variants);
        }
        res.json({ success: true, deleted: phones.length });
    } catch (e) {
        console.error('Erro ao apagar conversas em lote:', e);
        res.status(500).json({ error: 'Erro interno ao apagar conversas.' });
    }
});

// 5.5 Perfil Comercial do WhatsApp (Obter da Meta)
app.get('/api/whatsapp/business-profile', async (req, res) => {
    const phone_id = process.env.META_WA_PHONE_ID;
    const token = process.env.META_WA_ACCESS_TOKEN;
    if (!phone_id || !token) {
        return res.status(500).json({ error: "Credenciais do WhatsApp não configuradas no servidor." });
    }
    try {
        const response = await fetch(`https://graph.facebook.com/v20.0/${phone_id}/whatsapp_business_profile?fields=about,address,description,email,vertical,websites`, {
            headers: { "Authorization": `Bearer ${token}` }
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error?.message || "Erro ao buscar perfil da Meta");
        res.status(200).json({ success: true, data: result.data ? result.data[0] : {} });
    } catch(e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// 5.6 Perfil Comercial do WhatsApp (Salvar na Meta)
app.post('/api/whatsapp/business-profile', async (req, res) => {
    const phone_id = process.env.META_WA_PHONE_ID;
    const token = process.env.META_WA_ACCESS_TOKEN;
    if (!phone_id || !token) {
        return res.status(500).json({ error: "Credenciais do WhatsApp não configuradas no servidor." });
    }
    const { address, description, email, vertical, websites } = req.body;
    try {
        const response = await fetch(`https://graph.facebook.com/v20.0/${phone_id}/whatsapp_business_profile`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                messaging_product: "whatsapp",
                address: address || "",
                description: description || "",
                email: email || "",
                vertical: vertical || "OTHER",
                websites: Array.isArray(websites) ? websites : []
            })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error?.message || "Erro ao salvar perfil na Meta");
        res.status(200).json({ success: true, data: result });
    } catch(e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ==========================================
// TEMPLATES DE MENSAGEM (Meta WhatsApp Business Management API)
// ==========================================
// O status de aprovação nunca é guardado localmente — sempre busca ao vivo na
// Meta, que é a única fonte de verdade real (evita o template aparecer
// "aprovado" aqui enquanto foi rejeitado/pausado do lado de lá).
app.get('/api/whatsapp/templates', async (req, res) => {
    const wabaId = process.env.META_WABA_ID;
    const token = process.env.META_WA_ACCESS_TOKEN;
    if (!wabaId) {
        return res.status(500).json({ error: 'META_WABA_ID não configurado no servidor.' });
    }
    try {
        const response = await fetch(`https://graph.facebook.com/v20.0/${wabaId}/message_templates?fields=name,status,category,language,components&limit=100`, {
            headers: { "Authorization": `Bearer ${token}` }
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error?.message || "Erro ao buscar templates na Meta");
        res.status(200).json({ success: true, data: result.data || [] });
    } catch (e) {
        console.error('Erro ao listar templates:', e);
        res.status(500).json({ error: e.message || 'Erro interno do servidor.' });
    }
});

app.delete('/api/whatsapp/templates/:name', async (req, res) => {
    const wabaId = process.env.META_WABA_ID;
    const token = process.env.META_WA_ACCESS_TOKEN;
    if (!wabaId) {
        return res.status(500).json({ error: 'META_WABA_ID não configurado no servidor.' });
    }
    try {
        const response = await fetch(`https://graph.facebook.com/v20.0/${wabaId}/message_templates?name=${encodeURIComponent(req.params.name)}`, {
            method: 'DELETE',
            headers: { "Authorization": `Bearer ${token}` }
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error?.message || "Erro ao excluir template na Meta");
        res.status(200).json({ success: true });
    } catch (e) {
        console.error('Erro ao excluir template:', e);
        res.status(500).json({ error: e.message || 'Erro interno do servidor.' });
    }
});

// 6. Respostas Rápidas (Quick Replies)
app.get('/api/whatsapp/quick-replies', async (req, res) => {
    try {
        const rows = await queryD1('SELECT * FROM wa_quick_replies ORDER BY shortcut ASC');
        res.json({ success: true, data: rows });
    } catch(e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

app.post('/api/whatsapp/quick-replies', async (req, res) => {
    try {
        const { shortcut, text } = req.body;
        if(!shortcut || !text) return res.status(400).json({ error: "shortcut e text são obrigatórios" });
        await queryD1('INSERT OR REPLACE INTO wa_quick_replies (shortcut, text) VALUES (?, ?)', [shortcut, text]);
        res.json({ success: true });
    } catch(e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

app.delete('/api/whatsapp/quick-replies', async (req, res) => {
    try {
        const { shortcut } = req.query;
        if(!shortcut) return res.status(400).json({ error: "shortcut é obrigatório" });
        await queryD1('DELETE FROM wa_quick_replies WHERE shortcut = ?', [shortcut]);
        res.json({ success: true });
    } catch(e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// 7. Marcar como Lida
app.post('/api/whatsapp/mark-read', async (req, res) => {
    try {
        const { phone } = req.body;
        if(!phone) return res.status(400).json({ error: "phone é obrigatório" });

        const digits = String(phone).replace(/\D/g, '');
        const normalized = digits.startsWith('55') ? digits : '55' + digits;
        const phonesSet = new Set([normalized, digits]);
        if (normalized.length === 13) {
            const local = normalized.slice(4);
            if (local.startsWith('9')) {
                const sem9 = normalized.slice(0, 4) + local.slice(1);
                phonesSet.add(sem9);
                phonesSet.add(sem9.replace(/^55/, ''));
            }
        }
        if (normalized.length === 12) {
            const com9 = normalized.slice(0, 4) + '9' + normalized.slice(4);
            phonesSet.add(com9);
            phonesSet.add(com9.replace(/^55/, ''));
        }
        const phonesArr = Array.from(phonesSet);
        const placeholders = phonesArr.map(() => '?').join(', ');
        await queryD1(`UPDATE wa_messages SET status = 'read' WHERE phone IN (${placeholders}) AND direction = 'in'`, phonesArr);
        res.json({ success: true });
    } catch(e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// Espelho da Rota Serverless para Listar Agenda (Local)
app.get('/api/agenda', async (req, res) => {
    const AMIGO_API_TOKEN = await getAmigoToken(req.query.unidade_id);
    if (!AMIGO_API_TOKEN) return res.status(500).json({ error: 'Token não configurado' });

    // Pegar as datas da query ou usar a data de hoje como fallback
    const today = new Date().toISOString().split('T')[0];
    const startDate = req.query.start_date || today;
    const endDate = req.query.end_date || startDate;

    const url = `https://amigobot-api.amigoapp.com.br/attendances?start_date=${startDate}&end_date=${endDate}&status=ALL`;

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${AMIGO_API_TOKEN}` }
        });
        
        let realData = [];
        try { realData = await response.json(); } catch(e) {}
        
        if (!response.ok) {
            throw new Error(realData.message || 'Erro ao consultar Amigo App');
        }
        
        res.status(200).json({ data: realData.data || realData });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro interno' });
    }
});

// ==========================================
// BANCO DE DADOS (CLOUDFLARE D1)
// ==========================================

async function queryD1(sql, params = []) {
    const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_D1_DATABASE_ID } = process.env;
    
    if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN || !CLOUDFLARE_D1_DATABASE_ID) {
        throw new Error("Chaves da Cloudflare não configuradas no .env");
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${CLOUDFLARE_D1_DATABASE_ID}/query`;
    
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ sql, params })
    });

    const data = await response.json();
    if (!data.success) {
        throw new Error(data.errors?.[0]?.message || 'Erro na Cloudflare D1');
    }
    
    return data.result[0].results || [];
}

// Migration para garantir coluna quoted_id no D1
queryD1("ALTER TABLE wa_messages ADD COLUMN quoted_id TEXT").catch(() => {});
// Migration para suportar troca obrigatória de senha no primeiro acesso
queryD1("ALTER TABLE crm_users ADD COLUMN must_change_password INTEGER DEFAULT 0").catch(() => {});
// Personalização de perfil do atendente
queryD1("ALTER TABLE crm_users ADD COLUMN display_name TEXT").catch(() => {});
queryD1("ALTER TABLE crm_users ADD COLUMN avatar_url TEXT").catch(() => {});
// Presença online (bolinha verde/vermelha + "visto por último")
queryD1("ALTER TABLE crm_users ADD COLUMN last_seen_at DATETIME").catch(() => {});
// Foto do profissional nas notificações de presença (ex.: "fulano entrou no sistema")
queryD1("ALTER TABLE crm_notifications ADD COLUMN avatar_url TEXT").catch(() => {});
// Quem disparou a notificação (ex.: login) — usado pra não notificar a própria
// pessoa de uma ação que ela mesma fez (ex.: "você entrou no sistema").
queryD1("ALTER TABLE crm_notifications ADD COLUMN actor_username TEXT").catch(() => {});

// Considera "online" quem mandou heartbeat nos últimos 90s
const ONLINE_THRESHOLD_MS = 90 * 1000;
// Tabela de aniversariantes — substitui o CSV em disco (que guardava CPF e dado
// financeiro sem necessidade; só nome/data de nascimento/celular são usados).
queryD1("CREATE TABLE IF NOT EXISTS aniversariantes (id_amigo TEXT PRIMARY KEY, nome TEXT, data_nasc TEXT, celular TEXT)").catch(() => {});

// Rastreamento de origem de leads (UTMs para online, QR/link com frase-gatilho para mídia física)
queryD1(`CREATE TABLE IF NOT EXISTS crm_campaigns (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    canal TEXT NOT NULL,
    trigger_text TEXT,
    destino_url TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    link TEXT NOT NULL,
    status TEXT DEFAULT 'ativa',
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});
queryD1("ALTER TABLE crm_campaigns ADD COLUMN valor_investido REAL DEFAULT 0").catch(() => {});
queryD1("ALTER TABLE crm_campaigns ADD COLUMN slug TEXT").catch(() => {});
// Contabiliza scans/cliques do link curto de cada campanha (visibilidade de mídia
// física antes de virar conversa — hoje só sabíamos quando alguém mandava mensagem).
queryD1(`CREATE TABLE IF NOT EXISTS crm_campaign_clicks (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    clicked_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});

// Configurações simples de chave/valor (ex.: meta de receita do dashboard) —
// evita criar uma tabela dedicada pra cada configuração pontual do sistema.
queryD1(`CREATE TABLE IF NOT EXISTS crm_settings (
    key TEXT PRIMARY KEY,
    value TEXT
)`).catch(() => {});

// ==========================================
// UNIDADES (multi-clínica) — cada unidade tem sua própria conta/token do Amigo,
// pra futuramente suportar mais de uma clínica (ex.: Taguatinga + Planaltina) sem
// misturar agenda/pacientes de uma com a da outra.
// ==========================================
queryD1(`CREATE TABLE IF NOT EXISTS crm_unidades (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    amigo_api_token TEXT,
    ativo INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).then(async () => {
    // Migração automática: se a tabela estiver vazia, cria a unidade atual
    // (Taguatinga) usando o token que já está no .env — assim o sistema
    // continua funcionando exatamente igual, sem precisar de nenhum passo manual.
    try {
        const existing = await queryD1('SELECT id FROM crm_unidades LIMIT 1');
        if ((!existing || existing.length === 0) && process.env.AMIGO_API_TOKEN) {
            await queryD1(
                'INSERT INTO crm_unidades (id, nome, amigo_api_token, ativo) VALUES (?, ?, ?, 1)',
                ['unidade-taguatinga', 'Natuclinic Taguatinga', process.env.AMIGO_API_TOKEN]
            );
        }
    } catch (e) {
        console.error('Erro ao migrar unidade padrão:', e);
    }
}).catch(() => {});

// Resolve qual token do Amigo usar: da unidade pedida, senão a primeira
// unidade ativa cadastrada, senão o token solto do .env (compatibilidade).
async function getAmigoToken(unidadeId) {
    try {
        if (unidadeId) {
            const rows = await queryD1('SELECT amigo_api_token FROM crm_unidades WHERE id = ? AND ativo = 1', [unidadeId]);
            if (rows && rows[0] && rows[0].amigo_api_token) return rows[0].amigo_api_token;
        }
        const fallbackRows = await queryD1('SELECT amigo_api_token FROM crm_unidades WHERE ativo = 1 ORDER BY created_at ASC LIMIT 1');
        if (fallbackRows && fallbackRows[0] && fallbackRows[0].amigo_api_token) return fallbackRows[0].amigo_api_token;
    } catch (e) {
        console.error('Erro ao resolver token da unidade:', e);
    }
    return process.env.AMIGO_API_TOKEN || null;
}

app.get('/api/unidades', async (req, res) => {
    try {
        const rows = await queryD1('SELECT id, nome, ativo, created_at FROM crm_unidades ORDER BY created_at ASC');
        res.json({ items: rows || [] });
    } catch (e) {
        console.error('Erro ao listar unidades:', e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

app.post('/api/unidades', async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradores podem cadastrar unidades.' });
    }
    try {
        const { nome, amigo_api_token } = req.body;
        if (!nome || !nome.trim()) {
            return res.status(400).json({ error: 'Nome da unidade é obrigatório.' });
        }
        const id = `unidade-${Date.now()}`;
        await queryD1(
            'INSERT INTO crm_unidades (id, nome, amigo_api_token, ativo) VALUES (?, ?, ?, 1)',
            [id, nome.trim(), amigo_api_token ? amigo_api_token.trim() : null]
        );
        res.status(201).json({ success: true, id });
    } catch (e) {
        console.error('Erro ao criar unidade:', e);
        res.status(500).json({ error: 'Erro interno ao criar unidade.' });
    }
});

app.put('/api/unidades/:id', async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradores podem editar unidades.' });
    }
    try {
        const { nome, amigo_api_token, ativo } = req.body;
        const updates = [];
        const params = [];
        if (nome !== undefined) { updates.push('nome = ?'); params.push(nome.trim()); }
        if (amigo_api_token !== undefined) { updates.push('amigo_api_token = ?'); params.push(amigo_api_token.trim() || null); }
        if (ativo !== undefined) { updates.push('ativo = ?'); params.push(ativo ? 1 : 0); }
        if (updates.length === 0) return res.status(400).json({ error: 'Nada pra atualizar.' });

        params.push(req.params.id);
        await queryD1(`UPDATE crm_unidades SET ${updates.join(', ')} WHERE id = ?`, params);
        res.json({ success: true });
    } catch (e) {
        console.error('Erro ao editar unidade:', e);
        res.status(500).json({ error: 'Erro interno ao editar unidade.' });
    }
});

app.delete('/api/unidades/:id', async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradores podem excluir unidades.' });
    }
    try {
        const remaining = await queryD1('SELECT COUNT(*) as total FROM crm_unidades');
        if ((remaining?.[0]?.total || 0) <= 1) {
            return res.status(400).json({ error: 'Não é possível excluir a única unidade cadastrada.' });
        }
        await queryD1('DELETE FROM crm_unidades WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        console.error('Erro ao excluir unidade:', e);
        res.status(500).json({ error: 'Erro interno ao excluir unidade.' });
    }
});

app.get('/api/settings/dashboard-goal', async (req, res) => {
    try {
        const rows = await queryD1("SELECT value FROM crm_settings WHERE key = 'dashboard_revenue_goal'");
        const valor = rows && rows[0] ? parseFloat(rows[0].value) : null;
        res.json({ valor: (valor && valor > 0) ? valor : null });
    } catch (e) {
        console.error('Erro ao buscar meta do dashboard:', e);
        res.status(500).json({ error: 'Erro interno ao buscar meta.' });
    }
});

app.put('/api/settings/dashboard-goal', async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradores podem definir a meta.' });
    }
    try {
        const valor = parseFloat(req.body.valor);
        if (isNaN(valor) || valor < 0) {
            return res.status(400).json({ error: 'Valor de meta inválido.' });
        }
        await queryD1(
            "INSERT INTO crm_settings (key, value) VALUES ('dashboard_revenue_goal', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [String(valor)]
        );
        res.json({ success: true, valor });
    } catch (e) {
        console.error('Erro ao salvar meta do dashboard:', e);
        res.status(500).json({ error: 'Erro interno ao salvar meta.' });
    }
});

// ==========================================
// BIBLIOTECA DE ÁUDIOS (mensagens de voz pré-gravadas)
// ==========================================
// Guarda o áudio já convertido (OGG/Opus) como base64 no D1 — não reaproveita
// media_id da Meta porque mídia enviada por lá expira, então cada envio faz
// upload de novo a partir do arquivo salvo aqui.
queryD1(`CREATE TABLE IF NOT EXISTS crm_voice_library (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    audio_base64 TEXT NOT NULL,
    duration_seconds INTEGER,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});

app.get('/api/voice-library', async (req, res) => {
    try {
        const rows = await queryD1('SELECT id, nome, duration_seconds, created_by, created_at FROM crm_voice_library ORDER BY created_at DESC');
        res.json({ items: rows || [] });
    } catch (e) {
        console.error('Erro ao listar biblioteca de áudios:', e);
        res.status(500).json({ error: 'Erro interno ao listar áudios.' });
    }
});

app.get('/api/voice-library/:id/audio', async (req, res) => {
    try {
        const rows = await queryD1('SELECT audio_base64 FROM crm_voice_library WHERE id = ?', [req.params.id]);
        if (!rows || rows.length === 0) return res.status(404).send('Áudio não encontrado.');
        res.set('Content-Type', 'audio/ogg');
        res.send(Buffer.from(rows[0].audio_base64, 'base64'));
    } catch (e) {
        console.error('Erro ao buscar áudio da biblioteca:', e);
        res.status(500).send('Erro interno.');
    }
});

app.post('/api/voice-library', async (req, res) => {
    try {
        const { nome, audio, duration_seconds } = req.body;
        if (!nome || !nome.trim()) {
            return res.status(400).json({ error: 'Dê um nome pra esse áudio.' });
        }
        const match = (audio || '').match(/^data:(.*?);base64,(.*)$/s);
        if (!match) {
            return res.status(400).json({ error: 'Áudio inválido.' });
        }
        const mimeType = match[1];
        let buffer = Buffer.from(match[2], 'base64');

        if (mimeType !== 'audio/ogg') {
            const sourceExt = (mimeType.split('/')[1] || 'webm').split(';')[0];
            buffer = await convertToOggOpus(buffer, sourceExt);
        }

        const id = `voice-${Date.now()}`;
        await queryD1(
            'INSERT INTO crm_voice_library (id, nome, audio_base64, duration_seconds, created_by) VALUES (?, ?, ?, ?, ?)',
            [id, nome.trim(), buffer.toString('base64'), duration_seconds || null, req.user?.username || null]
        );
        res.status(201).json({ success: true, id });
    } catch (e) {
        console.error('Erro ao salvar áudio na biblioteca:', e);
        res.status(500).json({ error: e.message || 'Erro interno ao salvar áudio.' });
    }
});

app.delete('/api/voice-library/:id', async (req, res) => {
    try {
        await queryD1('DELETE FROM crm_voice_library WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        console.error('Erro ao excluir áudio da biblioteca:', e);
        res.status(500).json({ error: 'Erro interno ao excluir áudio.' });
    }
});

// Compara o texto de uma mensagem recebida com as frases-gatilho de qualquer campanha ativa
// que dependa disso pra identificar a origem — mídia física (QR code, panfleto) E também
// campanhas online (Google/Instagram/Site) cujo destino é o próprio WhatsApp da clínica,
// já que a Meta descarta qualquer UTM colocado num link wa.me (só "phone" e "text" chegam
// até a conversa de verdade). Nesses casos o link já vem com uma frase pré-preenchida
// única por campanha, e é essa frase que aparece na mensagem recebida.
async function matchTriggerCampaign(msgText) {
    try {
        const campaigns = await queryD1(
            "SELECT id, nome, trigger_text FROM crm_campaigns WHERE status = 'ativa' AND trigger_text IS NOT NULL"
        );
        if (!campaigns || campaigns.length === 0) return null;
        const normalized = msgText.trim().toLowerCase();
        return campaigns.find(c => normalized.includes(c.trigger_text.trim().toLowerCase())) || null;
    } catch (e) {
        console.error('Erro ao verificar campanha por frase-gatilho:', e);
        return null;
    }
}

// Busca (e guarda em memória) o número de WhatsApp da clínica direto na Meta,
// pra montar os links wa.me das campanhas sem precisar cadastrar isso à mão.
let cachedClinicWhatsAppNumber = null;
async function getClinicWhatsAppNumber() {
    if (cachedClinicWhatsAppNumber) return cachedClinicWhatsAppNumber;
    const phone_id = process.env.META_WA_PHONE_ID;
    const token = process.env.META_WA_ACCESS_TOKEN;
    if (!phone_id || !token) throw new Error('Credenciais do WhatsApp não configuradas no servidor.');

    const response = await fetch(`https://graph.facebook.com/v20.0/${phone_id}?fields=display_phone_number`, {
        headers: { "Authorization": `Bearer ${token}` }
    });
    const json = await response.json();
    if (!response.ok || !json.display_phone_number) {
        throw new Error(json.error ? json.error.message : 'Não foi possível obter o número do WhatsApp da clínica.');
    }
    cachedClinicWhatsAppNumber = json.display_phone_number.replace(/[^\d]/g, '');
    return cachedClinicWhatsAppNumber;
}

// ==========================================
// GESTÃO DE CAMPANHAS (Origem de Leads / UTMs)
// ==========================================

// Um link wa.me/api.whatsapp.com só reconhece os parâmetros "phone" e "text" — qualquer
// utm_source/utm_medium/utm_campaign colocado na URL é descartado antes de chegar na
// conversa de verdade. Então pra campanha nenhuma (Google, Instagram, Site ou Físico)
// que aponte pro WhatsApp da própria clínica, a única forma de saber de onde a pessoa
// veio é embutir uma frase-gatilho única no texto pré-preenchido da mensagem.
function isWhatsAppDestino(url) {
    if (!url) return false;
    return /(^|\/\/)(wa\.me|api\.whatsapp\.com)\//i.test(url.trim()) || /^wa\.me\//i.test(url.trim());
}

// Monta o link final da campanha a partir dos dados de canal.
async function buildCampaignLink(canal, { nome, trigger_text, destino_url, utm_source, utm_medium, utm_campaign }) {
    if (canal === 'fisico' || isWhatsAppDestino(destino_url)) {
        const finalTrigger = (trigger_text && trigger_text.trim()) || `Olá! Vim de: ${nome}`;
        const number = await getClinicWhatsAppNumber();
        return { link: `https://wa.me/${number}?text=${encodeURIComponent(finalTrigger)}`, trigger_text: finalTrigger };
    }

    if (!destino_url) {
        throw new Error('URL de destino é obrigatória para campanhas online.');
    }
    const finalSource = utm_source || canal;
    const finalMedium = utm_medium || (canal === 'site' ? 'organic' : 'cpc');
    const finalCampaign = utm_campaign || nome.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    const urlObj = new URL(destino_url);
    urlObj.searchParams.set('utm_source', finalSource);
    urlObj.searchParams.set('utm_medium', finalMedium);
    urlObj.searchParams.set('utm_campaign', finalCampaign);

    return { link: urlObj.toString(), utm_source: finalSource, utm_medium: finalMedium, utm_campaign: finalCampaign };
}

function slugify(text) {
    return text.toLowerCase()
        .normalize('NFD')
        .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
        .slice(0, 40);
}

async function generateUniqueSlug(nome) {
    const base = slugify(nome) || 'campanha';
    for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
        const existing = await queryD1('SELECT id FROM crm_campaigns WHERE slug = ?', [candidate]);
        if (!existing || existing.length === 0) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
}

// O link curto (/r/:slug) só serve pra contar scan/clique antes de mandar pro WhatsApp —
// mas ele PRECISA estar num domínio público de verdade, porque quem escaneia o QR faz isso
// do próprio celular. Se o admin está acessando via localhost (dev local na própria máquina)
// ou o cloudflared (que muda de endereço toda vez que reinicia), gerar o link curto em cima
// desse endereço quebraria assim que a pessoa tentasse abrir de fora. Nesses casos, usa o
// link direto pro WhatsApp mesmo (sem o hop de contagem) — a origem continua funcionando
// normalmente via a frase-gatilho, só perde a métrica extra de "quantos escanearam".
function isStablePublicHost(req) {
    const host = (req.get('host') || '').split(':')[0].toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
    if (host.endsWith('.trycloudflare.com')) return false;
    return true;
}

app.get('/api/campaigns', async (req, res) => {
    try {
        const campaigns = await queryD1('SELECT * FROM crm_campaigns ORDER BY created_at DESC');
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const canUseShortLink = isStablePublicHost(req);

        const withStats = await Promise.all((campaigns || []).map(async (c) => {
            // Casa tanto pelo nome da campanha (mídia física, atribuição manual)
            // quanto pelo utm_campaign (o que o site manda de verdade quando segue
            // o snippet de integração) — sem isso, campanhas online nunca batiam
            // porque o site manda o slug, não o nome bonito da campanha.
            const [leadsRows, convertidosRows, receitaRows, clicksRows] = await Promise.all([
                queryD1('SELECT COUNT(*) as total FROM leads WHERE origem = ? OR origem = ?', [c.nome, c.utm_campaign]),
                queryD1("SELECT COUNT(*) as total FROM leads WHERE (origem = ? OR origem = ?) AND column_id = 'col-ganho'", [c.nome, c.utm_campaign]),
                queryD1("SELECT COALESCE(SUM(valor_recebido), 0) as total FROM leads WHERE (origem = ? OR origem = ?) AND column_id IN ('col-ganho', 'col-agendado')", [c.nome, c.utm_campaign]),
                queryD1('SELECT COUNT(*) as total FROM crm_campaign_clicks WHERE campaign_id = ?', [c.id])
            ]);

            const leads_count = leadsRows?.[0]?.total || 0;
            const convertidos_count = convertidosRows?.[0]?.total || 0;
            const valor_gerado = receitaRows?.[0]?.total || 0;
            const clicks_count = clicksRows?.[0]?.total || 0;
            const valor_investido = parseFloat(c.valor_investido) || 0;

            return {
                ...c,
                leads_count,
                convertidos_count,
                valor_gerado,
                clicks_count,
                cpl: leads_count > 0 && valor_investido > 0 ? (valor_investido / leads_count) : null,
                roi: valor_investido > 0 ? ((valor_gerado - valor_investido) / valor_investido) * 100 : null,
                short_link: (c.slug && canUseShortLink) ? `${baseUrl}/r/${c.slug}` : null
            };
        }));

        res.json({ campaigns: withStats });
    } catch (e) {
        console.error('Erro ao listar campanhas:', e);
        res.status(500).json({ error: 'Erro interno ao listar campanhas.' });
    }
});

app.post('/api/campaigns', async (req, res) => {
    try {
        const { nome, canal, trigger_text, destino_url, utm_source, utm_medium, utm_campaign, valor_investido } = req.body;

        if (!nome || !canal) {
            return res.status(400).json({ error: 'Nome e canal da campanha são obrigatórios.' });
        }

        const id = `camp-${Date.now()}`;
        const slug = await generateUniqueSlug(nome);
        const built = await buildCampaignLink(canal, { nome, trigger_text, destino_url, utm_source, utm_medium, utm_campaign });
        const investido = parseFloat(valor_investido) || 0;

        if (built.trigger_text !== undefined) {
            // Canal físico OU um canal online (Google/Instagram/Site) cujo destino é o
            // próprio WhatsApp — os dois usam frase-gatilho em vez de UTM pra identificar a origem.
            await queryD1(
                'INSERT INTO crm_campaigns (id, nome, canal, trigger_text, destino_url, link, slug, valor_investido, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [id, nome, canal, built.trigger_text, destino_url || null, built.link, slug, investido, req.user?.username || null]
            );
        } else {
            await queryD1(
                'INSERT INTO crm_campaigns (id, nome, canal, destino_url, utm_source, utm_medium, utm_campaign, link, slug, valor_investido, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [id, nome, canal, destino_url, built.utm_source, built.utm_medium, built.utm_campaign, built.link, slug, investido, req.user?.username || null]
            );
        }

        const [created] = await queryD1('SELECT * FROM crm_campaigns WHERE id = ?', [id]);
        res.status(201).json({ campaign: created });
    } catch (e) {
        console.error('Erro ao criar campanha:', e);
        res.status(400).json({ error: e.message || 'Erro ao criar campanha.' });
    }
});

app.put('/api/campaigns/:id', async (req, res) => {
    try {
        const existingRows = await queryD1('SELECT * FROM crm_campaigns WHERE id = ?', [req.params.id]);
        if (!existingRows || existingRows.length === 0) {
            return res.status(404).json({ error: 'Campanha não encontrada.' });
        }
        const existing = existingRows[0];
        const { nome, trigger_text, destino_url, utm_source, utm_medium, utm_campaign, valor_investido } = req.body;

        if (!nome) {
            return res.status(400).json({ error: 'Nome da campanha é obrigatório.' });
        }

        const built = await buildCampaignLink(existing.canal, { nome, trigger_text, destino_url, utm_source, utm_medium, utm_campaign });
        const investido = valor_investido !== undefined ? (parseFloat(valor_investido) || 0) : (parseFloat(existing.valor_investido) || 0);

        if (built.trigger_text !== undefined) {
            await queryD1(
                'UPDATE crm_campaigns SET nome = ?, trigger_text = ?, destino_url = ?, utm_source = NULL, utm_medium = NULL, utm_campaign = NULL, link = ?, valor_investido = ? WHERE id = ?',
                [nome, built.trigger_text, destino_url || null, built.link, investido, req.params.id]
            );
        } else {
            await queryD1(
                'UPDATE crm_campaigns SET nome = ?, destino_url = ?, utm_source = ?, utm_medium = ?, utm_campaign = ?, trigger_text = NULL, link = ?, valor_investido = ? WHERE id = ?',
                [nome, destino_url, built.utm_source, built.utm_medium, built.utm_campaign, built.link, investido, req.params.id]
            );
        }

        // Recadastra os leads que já estavam ligados ao nome/UTM antigos da campanha —
        // sem isso, renomear uma campanha "perde" o histórico de leads já atribuídos
        // a ela (eles ficam com o nome velho gravado, órfãos, e a campanha zera).
        const oldAttributionValues = [existing.nome, existing.utm_campaign].filter(v => v && v !== nome);
        if (oldAttributionValues.length > 0) {
            const placeholders = oldAttributionValues.map(() => '?').join(', ');
            await queryD1(`UPDATE leads SET origem = ? WHERE origem IN (${placeholders})`, [nome, ...oldAttributionValues]);
        }

        const [updated] = await queryD1('SELECT * FROM crm_campaigns WHERE id = ?', [req.params.id]);
        res.json({ campaign: updated });
    } catch (e) {
        console.error('Erro ao editar campanha:', e);
        res.status(400).json({ error: e.message || 'Erro ao editar campanha.' });
    }
});

app.patch('/api/campaigns/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        if (!['ativa', 'arquivada'].includes(status)) {
            return res.status(400).json({ error: 'Status inválido.' });
        }
        await queryD1('UPDATE crm_campaigns SET status = ? WHERE id = ?', [status, req.params.id]);
        res.json({ success: true });
    } catch (e) {
        console.error('Erro ao atualizar status da campanha:', e);
        res.status(500).json({ error: 'Erro interno ao atualizar campanha.' });
    }
});

app.delete('/api/campaigns/:id', async (req, res) => {
    try {
        await queryD1('DELETE FROM crm_campaigns WHERE id = ?', [req.params.id]);
        await queryD1('DELETE FROM crm_campaign_clicks WHERE campaign_id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        console.error('Erro ao excluir campanha:', e);
        res.status(500).json({ error: 'Erro interno ao excluir campanha.' });
    }
});

app.get('/api/campaigns/:id/qrcode', async (req, res) => {
    try {
        const rows = await queryD1('SELECT link, nome, slug FROM crm_campaigns WHERE id = ?', [req.params.id]);
        if (!rows || rows.length === 0) {
            return res.status(404).json({ error: 'Campanha não encontrada.' });
        }
        // Usa o link curto (que conta scans) só quando o domínio atual é público e estável —
        // senão o QR ficaria apontando pra um endereço que não existe fora desta máquina.
        const target = (rows[0].slug && isStablePublicHost(req)) ? `${req.protocol}://${req.get('host')}/r/${rows[0].slug}` : rows[0].link;
        const buffer = await QRCode.toBuffer(target, { width: 1000, margin: 2 });
        res.set('Content-Type', 'image/png');
        res.send(buffer);
    } catch (e) {
        console.error('Erro ao gerar QR code:', e);
        res.status(500).json({ error: 'Erro interno ao gerar QR code.' });
    }
});

// Export CSV dos leads agrupados por origem/campanha (não exige autenticação de admin
// pra manter simples, mas fica sob o mesmo requireAuth geral do /api).
app.get('/api/campaigns/export-leads', async (req, res) => {
    try {
        const rows = await queryD1("SELECT nome, telefone, origem, column_id, valor_recebido, created_at FROM leads ORDER BY origem, created_at DESC");
        const header = 'Nome,Telefone,Origem,Status,Valor Recebido,Criado em\n';
        const csvBody = (rows || []).map(r => {
            const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
            return [esc(r.nome), esc(r.telefone), esc(r.origem || 'Não informado'), esc(r.column_id), esc(r.valor_recebido || 0), esc(r.created_at)].join(',');
        }).join('\n');

        res.set('Content-Type', 'text/csv; charset=utf-8');
        res.set('Content-Disposition', 'attachment; filename="leads_por_origem.csv"');
        res.send('﻿' + header + csvBody);
    } catch (e) {
        console.error('Erro ao exportar leads por origem:', e);
        res.status(500).json({ error: 'Erro interno ao exportar leads.' });
    }
});

// Link curto público (impresso em panfletos/QR) — registra o "scan" antes de
// redirecionar, pra dar visibilidade de quantas pessoas viram a mídia física
// mesmo quando não chegam a mandar mensagem.
app.get('/r/:slug', shortLinkLimiter, async (req, res) => {
    try {
        const rows = await queryD1('SELECT id, link FROM crm_campaigns WHERE slug = ?', [req.params.slug]);
        if (!rows || rows.length === 0) {
            return res.status(404).send('Link não encontrado.');
        }
        const campaign = rows[0];
        queryD1('INSERT INTO crm_campaign_clicks (id, campaign_id) VALUES (?, ?)', [`clk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, campaign.id]).catch(() => {});
        res.redirect(302, campaign.link);
    } catch (e) {
        console.error('Erro ao processar link curto:', e);
        res.status(500).send('Erro interno.');
    }
});

// ==========================================
// BUSCA DE PACIENTES POR NOME (Ao Vivo)
// ==========================================

app.get('/api/buscar-paciente', async (req, res) => {
    const { nome } = req.query;
    if (!nome || nome.trim().length < 2) {
        return res.json({ pacientes: [] });
    }

    const AMIGO_API_TOKEN = await getAmigoToken(req.query.unidade_id);
    if (!AMIGO_API_TOKEN) return res.status(500).json({ error: 'Token não configurado' });

    const headers = { 'Authorization': `Bearer ${AMIGO_API_TOKEN}` };
    const nomeLower = nome.trim().toLowerCase();

    // Monta as janelas de busca: últimos 6 meses em blocos de 30 dias (em paralelo)
    const hoje = new Date();
    const janelas = [];
    for (let i = 0; i < 6; i++) {
        const fim = new Date(hoje);
        fim.setMonth(hoje.getMonth() - i);
        const inicio = new Date(fim);
        inicio.setDate(1);
        janelas.push({
            start: inicio.toISOString().split('T')[0],
            end: fim.toISOString().split('T')[0]
        });
    }

    try {
        // Busca todos os meses em paralelo para ser rápido
        const respostas = await Promise.all(
            janelas.map(j =>
                fetch(`https://amigobot-api.amigoapp.com.br/attendances?start_date=${j.start}&end_date=${j.end}&status=ALL`, { headers })
                    .then(r => r.json())
                    .catch(() => ({ data: [] }))
            )
        );

        // Extrai e filtra pacientes pelo nome pesquisado
        const vistos = new Set();
        const pacientes = [];

        for (const resp of respostas) {
            for (const att of (resp.data || [])) {
                if (!att.patient || !att.patient.name) continue;
                const id = att.patient.id;
                if (vistos.has(id)) continue;
                if (!att.patient.name.toLowerCase().includes(nomeLower)) continue;
                vistos.add(id);
                pacientes.push({
                    id: att.patient.id,
                    nome: att.patient.name,
                    telefone: att.patient.cellphone || att.patient.contact_cellphone || '',
                    email: att.patient.email || '',
                    born: att.patient.born || att.patient.birthdate || ''
                });
            }
        }

        res.json({ pacientes });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// Inicializar Tabelas
app.post('/api/init-db', async (req, res) => {
    try {
        await queryD1(`
            CREATE TABLE IF NOT EXISTS wa_messages (
                id TEXT PRIMARY KEY,
                phone TEXT NOT NULL,
                direction TEXT NOT NULL,
                message TEXT,
                status TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS wa_quick_replies (
                shortcut TEXT PRIMARY KEY,
                text TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS wa_template_sends (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                phone TEXT NOT NULL,
                template_name TEXT NOT NULL,
                sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await queryD1(`
            CREATE TABLE IF NOT EXISTS mensagens_enviadas (
                id TEXT PRIMARY KEY,
                paciente_id TEXT NOT NULL,
                tipo TEXT,
                data_envio DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Removed DROP TABLE IF EXISTS leads to prevent data loss
        
        await queryD1(`
            CREATE TABLE IF NOT EXISTS leads (
                id TEXT PRIMARY KEY,
                nome TEXT NOT NULL,
                telefone TEXT,
                origem TEXT,
                born TEXT,
                owner_id TEXT,
                column_id TEXT DEFAULT 'col-entrada',
                fb_click_id TEXT,
                email TEXT,
                notas TEXT,
                tags TEXT,
                valor_recebido REAL,
                orcamento TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Públicos salvos: recortes de leads (por responsável, origem e período de
        // entrada) definidos no Kanban e reaproveitados no disparo de campanhas.
        await queryD1(`
            CREATE TABLE IF NOT EXISTS lead_audiences (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                owner_id TEXT,
                origem TEXT,
                date_start TEXT,
                date_end TEXT,
                has_schedule INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Tentativa de adicionar as colunas caso a tabela já exista (ignora o erro se já existirem)
        try { await queryD1('ALTER TABLE leads ADD COLUMN fb_click_id TEXT'); } catch(e) {}
        try { await queryD1('ALTER TABLE leads ADD COLUMN email TEXT'); } catch(e) {}
        try { await queryD1('ALTER TABLE leads ADD COLUMN notas TEXT'); } catch(e) {}
        try { await queryD1('ALTER TABLE leads ADD COLUMN tags TEXT'); } catch(e) {}
        try { await queryD1('ALTER TABLE leads ADD COLUMN valor_recebido REAL'); } catch(e) {}
        try { await queryD1('ALTER TABLE leads ADD COLUMN orcamento TEXT'); } catch(e) {}
        try { await queryD1('ALTER TABLE leads ADD COLUMN assigned_at DATETIME'); } catch(e) {}
        // Proteção anti-bloqueio: lead que optou por não receber disparos de campanha/marketing
        try { await queryD1('ALTER TABLE leads ADD COLUMN campaign_opt_out INTEGER DEFAULT 0'); } catch(e) {}
        
        await queryD1(`
            CREATE TABLE IF NOT EXISTS crm_users (
                username TEXT PRIMARY KEY,
                password TEXT NOT NULL,
                role TEXT DEFAULT 'user',
                must_change_password INTEGER DEFAULT 0
            )
        `);
        try { await queryD1('ALTER TABLE crm_users ADD COLUMN must_change_password INTEGER DEFAULT 0'); } catch(e) {}

        // Seed inicial com senha já em hash e troca obrigatória no primeiro acesso
        // (só é inserido em instalações novas — INSERT OR IGNORE não afeta contas já existentes).
        const seedAdminHash = await bcrypt.hash('admin123', 12);
        const seedCarolHash = await bcrypt.hash('carol123', 12);
        await queryD1('INSERT OR IGNORE INTO crm_users (username, password, role, must_change_password) VALUES (?, ?, ?, 1)', ['admin', seedAdminHash, 'admin']);
        await queryD1('INSERT OR IGNORE INTO crm_users (username, password, role, must_change_password) VALUES (?, ?, ?, 1)', ['carol', seedCarolHash, 'user']);
        
        await queryD1(`
            CREATE TABLE IF NOT EXISTS agendamentos_financeiro (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                lead_id TEXT,
                data_agendamento TEXT,
                nome_paciente TEXT,
                procedimento TEXT,
                unidade TEXT,
                origem TEXT,
                valor_primario TEXT,
                valor_secundario TEXT,
                status_pagamento TEXT,
                agendado_por TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        try { await queryD1('ALTER TABLE agendamentos_financeiro ADD COLUMN lead_id TEXT'); } catch(e) {}
        try { await queryD1('ALTER TABLE agendamentos_financeiro ADD COLUMN attendance_id TEXT'); } catch(e) {}
        
        await queryD1(`
            CREATE TABLE IF NOT EXISTS crm_notifications (
                id TEXT PRIMARY KEY,
                message TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        res.json({ success: true, message: "Tabelas inicializadas com sucesso no D1" });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// Registrar que uma mensagem foi enviada
app.post('/api/mensagens', async (req, res) => {
    const { paciente_id, tipo } = req.body;
    const id = Date.now().toString();
    try {
        await queryD1(
            'INSERT INTO mensagens_enviadas (id, paciente_id, tipo) VALUES (?, ?, ?)', 
            [id, String(paciente_id), tipo]
        );
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ==== ROTAS DE LOGIN ====
app.post('/api/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    const cleanUsername = (username || '').trim().toLowerCase();
    const cleanPassword = (password || '').trim();
    try {
        const rows = await queryD1('SELECT * FROM crm_users WHERE LOWER(username) = ?', [cleanUsername]);
        const dbUser = rows && rows[0];
        if (!dbUser) {
            return res.status(401).json({ error: 'Usuário ou senha inválidos' });
        }

        const storedPassword = dbUser.password || '';
        const isHashed = /^\$2[aby]\$/.test(storedPassword);
        let validPassword;

        if (isHashed) {
            validPassword = await bcrypt.compare(cleanPassword, storedPassword);
        } else {
            // Conta antiga com senha em texto puro: valida por igualdade e,
            // se bater, faz o upgrade automático para hash nesse exato login.
            validPassword = cleanPassword === storedPassword;
            if (validPassword) {
                // Conta que ainda estava na senha em texto puro (ex.: admin/carol da instalação original):
                // migra para hash agora e força a troca no próximo passo, já que a senha atual é previsível.
                const upgradedHash = await bcrypt.hash(cleanPassword, 12);
                await queryD1('UPDATE crm_users SET password = ?, must_change_password = 1 WHERE username = ?', [upgradedHash, dbUser.username]);
                dbUser.must_change_password = 1;
            }
        }

        if (!validPassword) {
            return res.status(401).json({ error: 'Usuário ou senha inválidos' });
        }

        const user = { username: dbUser.username, role: dbUser.role };
        const token = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '12h' });
        res.cookie('crm_token', token, {
            httpOnly: true,
            sameSite: 'lax',
            secure: !!process.env.VERCEL || process.env.NODE_ENV === 'production',
            maxAge: 12 * 60 * 60 * 1000
        });

        await queryD1('UPDATE crm_users SET last_seen_at = CURRENT_TIMESTAMP WHERE username = ?', [dbUser.username]);

        // Avisa o resto da equipe que esse atendente entrou — reaproveita o sino
        // de notificações que todo mundo já tem aberto e faz polling.
        try {
            const who = dbUser.display_name || dbUser.username;
            const loginMessage = `${who} entrou no sistema`;

            // Evita duplicar a notificação se o login disparar mais de uma vez em
            // pouco tempo (duplo clique, refresh, aba nova) — mesma pessoa, mesma
            // mensagem, últimos 2 minutos.
            const recent = await queryD1(
                `SELECT id FROM crm_notifications WHERE message = ? AND created_at > datetime('now', '-2 minutes') LIMIT 1`,
                [loginMessage]
            );

            if (!recent || recent.length === 0) {
                await queryD1(
                    'INSERT INTO crm_notifications (id, message, created_at, avatar_url, actor_username) VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?)',
                    [`login-${dbUser.username}-${Date.now()}`, loginMessage, dbUser.avatar_url || null, dbUser.username]
                );
            }
        } catch (e) {
            console.error('Erro ao registrar notificação de login:', e);
        }

        res.json({
            success: true,
            user: { ...user, display_name: dbUser.display_name || '', avatar_url: dbUser.avatar_url || '' },
            mustChangePassword: !!dbUser.must_change_password
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('crm_token');
    res.json({ success: true });
});

// Troca de senha — a identidade vem sempre da sessão (req.user), nunca do body.
app.post('/api/change-password', async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || String(newPassword).trim().length < 6) {
        return res.status(400).json({ error: 'A nova senha precisa ter pelo menos 6 caracteres.' });
    }
    try {
        const username = req.user.username;
        const rows = await queryD1('SELECT * FROM crm_users WHERE username = ?', [username]);
        const dbUser = rows && rows[0];
        if (!dbUser) return res.status(404).json({ error: 'Usuário não encontrado.' });

        const storedPassword = dbUser.password || '';
        const isHashed = /^\$2[aby]\$/.test(storedPassword);
        const currentValid = isHashed
            ? await bcrypt.compare(String(currentPassword || ''), storedPassword)
            : String(currentPassword || '').trim() === storedPassword;

        if (!currentValid) {
            return res.status(401).json({ error: 'Senha atual incorreta.' });
        }

        const newHash = await bcrypt.hash(String(newPassword).trim(), 12);
        await queryD1('UPDATE crm_users SET password = ?, must_change_password = 0 WHERE username = ?', [newHash, username]);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ==== PERFIL DO ATENDENTE ====
// A identidade vem sempre da sessão (req.user.username), nunca do body.
app.put('/api/me', async (req, res) => {
    const { display_name, avatar_url } = req.body;

    if (display_name !== undefined && String(display_name).length > 80) {
        return res.status(400).json({ error: 'Nome de exibição muito longo (máximo 80 caracteres).' });
    }
    // ~500KB em base64 é suficiente para uma foto de perfil pequena já redimensionada no navegador.
    if (avatar_url !== undefined && String(avatar_url).length > 500000) {
        return res.status(400).json({ error: 'Imagem muito grande. Escolha uma foto menor.' });
    }

    try {
        const updates = [];
        const params = [];
        if (display_name !== undefined) { updates.push('display_name = ?'); params.push(String(display_name).trim()); }
        if (avatar_url !== undefined) { updates.push('avatar_url = ?'); params.push(avatar_url); }

        if (updates.length > 0) {
            params.push(req.user.username);
            await queryD1(`UPDATE crm_users SET ${updates.join(', ')} WHERE username = ?`, params);
        }

        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// Mapa username -> nome de exibição, disponível para qualquer usuário logado
// (não só admin) para resolver "responsável" no Kanban sem expor senha/role de todo mundo.
app.get('/api/users/display-names', async (req, res) => {
    try {
        const rows = await queryD1('SELECT username, display_name FROM crm_users');
        const map = {};
        (rows || []).forEach(r => { map[r.username] = r.display_name || r.username; });
        res.json(map);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// Heartbeat de presença — o front chama isso periodicamente enquanto a aba está aberta.
app.post('/api/heartbeat', async (req, res) => {
    try {
        await queryD1('UPDATE crm_users SET last_seen_at = CURRENT_TIMESTAMP WHERE username = ?', [req.user.username]);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// Status online/offline + "visto por último" de toda a equipe.
app.get('/api/users/presence', async (req, res) => {
    try {
        const rows = await queryD1('SELECT username, display_name, avatar_url, last_seen_at FROM crm_users ORDER BY username ASC');
        const now = Date.now();
        const presence = (rows || []).map(r => {
            const lastSeenMs = r.last_seen_at ? new Date(r.last_seen_at.replace(' ', 'T') + 'Z').getTime() : null;
            const online = lastSeenMs ? (now - lastSeenMs) < ONLINE_THRESHOLD_MS : false;
            return {
                username: r.username,
                display_name: r.display_name || r.username,
                avatar_url: r.avatar_url || '',
                last_seen_at: r.last_seen_at || null,
                online
            };
        });
        res.json(presence);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ==== ROTAS DE GESTÃO DE USUÁRIOS (ADMIN) ====
app.get('/api/users', async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradores podem ver a lista de usuários.' });
    }
    try {
        const rows = await queryD1('SELECT username, role FROM crm_users ORDER BY username ASC');
        res.json(rows || []);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

app.post('/api/users', async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradores podem criar usuários.' });
    }
    const { username, password, role } = req.body;
    try {
        // Verifica se já existe
        const existing = await queryD1('SELECT username FROM crm_users WHERE username = ?', [username]);
        if (existing && existing.length > 0) {
            return res.status(400).json({ error: 'Usuário já existe' });
        }
        const hash = await bcrypt.hash(String(password || ''), 12);
        await queryD1('INSERT INTO crm_users (username, password, role, must_change_password) VALUES (?, ?, ?, 1)', [username, hash, role]);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

app.delete('/api/users/:username', async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradores podem excluir usuários.' });
    }
    const { username } = req.params;
    if (username === 'admin') {
        return res.status(400).json({ error: 'Não é possível excluir o administrador principal' });
    }
    try {
        await queryD1('DELETE FROM crm_users WHERE username = ?', [username]);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ==== ROTAS DE NOTIFICAÇÕES ====
app.get('/api/notifications', async (req, res) => {
    try {
        // Não mostra pra própria pessoa a notificação de uma ação que ela mesma
        // disparou (ex.: "Você entrou no sistema" ao fazer login).
        const rows = await queryD1(
            `SELECT * FROM crm_notifications
             WHERE actor_username IS NULL OR actor_username != ?
             ORDER BY created_at DESC LIMIT 50`,
            [req.user?.username || '']
        );
        res.json(rows || []);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

app.post('/api/clear-notif', async (req, res) => {
    try {
        await queryD1('DELETE FROM crm_notifications');
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ==== ROTAS DO KANBAN (LEADS) ====

// Buscar todos os leads
app.get('/api/leads', async (req, res) => {
    const { owner_id } = req.query;
    try {
        let rows;
        if (owner_id && owner_id !== 'admin') {
            rows = await queryD1('SELECT * FROM leads WHERE owner_id = ? ORDER BY created_at ASC', [owner_id]);
        } else {
            rows = await queryD1('SELECT * FROM leads ORDER BY created_at ASC');
        }
        res.json(rows || []);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ==========================================
// FUNÇÃO DE ENVIO PARA META CAPI
// ==========================================
async function sendMetaCapiEvent(eventName, userData) {
    const { META_PIXEL_ID, META_ACCESS_TOKEN } = process.env;
    if (!META_PIXEL_ID || !META_ACCESS_TOKEN) return;

    try {
        const hashData = (data) => {
            if (!data) return undefined;
            const clean = data.trim().toLowerCase();
            return crypto.createHash('sha256').update(clean).digest('hex');
        };

        const phoneHash = hashData(userData.telefone ? userData.telefone.replace(/\D/g, '') : '');
        const emailHash = hashData(userData.email);

        const payload = {
            data: [{
                event_name: eventName,
                event_time: Math.floor(Date.now() / 1000),
                action_source: 'system_generated',
                user_data: {
                    ph: phoneHash ? [phoneHash] : undefined,
                    em: emailHash ? [emailHash] : undefined,
                    fbc: userData.fb_click_id ? `fb.1.${Date.now()}.${userData.fb_click_id}` : undefined,
                    client_user_agent: 'Sistema_Clinica_CRM/1.0'
                }
            }]
        };

        const url = `https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events`;

        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${META_ACCESS_TOKEN}`
            },
            body: JSON.stringify(payload)
        });

        const result = await res.json();
        if (!res.ok) {
            console.error(`Erro ao enviar evento ${eventName} para a Meta:`, result);
        } else {
            console.log(`Evento ${eventName} enviado para a Meta com sucesso!`);
        }
    } catch (err) {
        console.error("Exceção ao disparar Meta CAPI:", err);
    }
}

// Criar um novo lead
app.post('/api/leads', async (req, res) => {
    const { id, nome, telefone, origem, born, owner_id, column_id, fb_click_id, email, notas, tags, valor_recebido, orcamento } = req.body;
    try {
        // Ponto único de criação de lead (usado tanto pelo cadastro manual quanto pelo chat
        // criando lead automaticamente): se já existe um lead com esse número em qualquer
        // forma equivalente (com/sem 55, com/sem o 9º dígito), não duplica — devolve o já existente.
        if (telefone) {
            const variants = phoneVariants(telefone);
            const placeholders = variants.map(() => '?').join(', ');
            const existingRows = await queryD1(`SELECT id FROM leads WHERE telefone IN (${placeholders})`, variants);
            if (existingRows && existingRows.length > 0) {
                return res.json({ success: true, id: existingRows[0].id, duplicate: true });
            }
        }

        await queryD1(
            'INSERT INTO leads (id, nome, telefone, origem, born, owner_id, column_id, fb_click_id, email, notas, tags, valor_recebido, orcamento) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [id, nome, telefone ? normalizePhoneBR(telefone) : '', origem || '', born || '', owner_id || null, column_id || 'col-entrada', fb_click_id || '', email || '', notas || '', tags || '', valor_recebido || null, orcamento || '']
        );
        res.json({ success: true, id });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// Atualizar dados de um lead (coluna e/ou notas)
app.put('/api/leads/:id', async (req, res) => {
    const { id } = req.params;
    const { column_id, notas, nome, telefone, born, email, tags, valor_recebido, orcamento, campaign_opt_out } = req.body;
    try {
        const leadRows = await queryD1('SELECT * FROM leads WHERE id = ?', [id]);
        const lead = leadRows && leadRows.length > 0 ? leadRows[0] : null;
        
        if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });

        const updates = [];
        const params = [];

        if (column_id !== undefined) {
            updates.push('column_id = ?');
            params.push(column_id || 'col-entrada');
        }
        if (notas !== undefined) {
            updates.push('notas = ?');
            params.push(notas);
        }
        if (nome !== undefined) {
            updates.push('nome = ?');
            params.push(nome);
        }
        if (telefone !== undefined) {
            updates.push('telefone = ?');
            params.push(telefone);
        }
        if (born !== undefined) {
            updates.push('born = ?');
            params.push(born);
        }
        if (email !== undefined) {
            updates.push('email = ?');
            params.push(email);
        }
        if (tags !== undefined) {
            updates.push('tags = ?');
            params.push(tags);
        }
        if (valor_recebido !== undefined) {
            updates.push('valor_recebido = ?');
            params.push(valor_recebido);
        }
        if (orcamento !== undefined) {
            updates.push('orcamento = ?');
            params.push(orcamento);
        }
        if (campaign_opt_out !== undefined) {
            updates.push('campaign_opt_out = ?');
            params.push(campaign_opt_out ? 1 : 0);
        }

        if (updates.length > 0) {
            params.push(id);
            await queryD1(`UPDATE leads SET ${updates.join(', ')} WHERE id = ?`, params);

            // Cascata para histórico de agendamentos se existirem registros com o mesmo lead_id
            try {
                if (nome !== undefined) {
                    await queryD1('UPDATE agendamentos_financeiro SET nome_paciente = ? WHERE lead_id = ?', [nome, id]);
                }
                if (orcamento !== undefined) {
                    try {
                        const parsed = typeof orcamento === 'string' ? JSON.parse(orcamento) : orcamento;
                        if (parsed && parsed.procedimento) {
                            await queryD1('UPDATE agendamentos_financeiro SET procedimento = ? WHERE lead_id = ?', [parsed.procedimento, id]);
                        }
                    } catch(err) {}
                }
            } catch (err) {
                console.error("Erro na cascata do histórico financeiro:", err);
            }
        }

        if (column_id === 'col-atendimento' && lead) {
            sendMetaCapiEvent('Lead', lead);
        }

        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ==== TRAVA DE ATENDIMENTO (evita que dois atendentes atropelem o mesmo lead) ====
// Enquanto um atendente estiver ativo numa conversa, ela fica travada para ele.
// Após LOCK_TIMEOUT_MINUTES sem renovação (heartbeat), a trava expira e a conversa
// volta a ficar disponível para qualquer atendente assumir.
const LOCK_TIMEOUT_MINUTES = 5;

// Assume o atendimento de um lead. É idempotente para quem já é o dono, e só
// permite "roubar" a posse se ela estiver vaga ou expirada (evita corrida entre
// dois atendentes abrindo o mesmo chat ao mesmo tempo, pois é um UPDATE condicional único).
app.post('/api/leads/:id/claim', async (req, res) => {
    const { id } = req.params;
    const username = req.user.username;
    try {
        await queryD1(
            `UPDATE leads SET owner_id = ?, assigned_at = CURRENT_TIMESTAMP
             WHERE id = ?
             AND (owner_id IS NULL OR owner_id = ? OR assigned_at IS NULL OR assigned_at < datetime('now', '-${LOCK_TIMEOUT_MINUTES} minutes'))`,
            [username, id, username]
        );

        const rows = await queryD1('SELECT id, owner_id, assigned_at FROM leads WHERE id = ?', [id]);
        const lead = rows && rows[0];
        if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });

        if (lead.owner_id === username) {
            return res.json({ success: true, owner_id: lead.owner_id, assigned_at: lead.assigned_at });
        }
        return res.status(409).json({ error: 'Conversa em atendimento por outro atendente.', owner_id: lead.owner_id, assigned_at: lead.assigned_at });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// Renova a posse (heartbeat) enquanto o atendente segue ativo na conversa.
app.post('/api/leads/:id/renew', async (req, res) => {
    const { id } = req.params;
    const username = req.user.username;
    try {
        await queryD1(
            `UPDATE leads SET assigned_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?`,
            [id, username]
        );

        const rows = await queryD1('SELECT id, owner_id, assigned_at FROM leads WHERE id = ?', [id]);
        const lead = rows && rows[0];
        if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });

        if (lead.owner_id === username) {
            return res.json({ success: true, owner_id: lead.owner_id, assigned_at: lead.assigned_at });
        }
        return res.status(409).json({ error: 'A posse desta conversa expirou e foi assumida por outro atendente.', owner_id: lead.owner_id, assigned_at: lead.assigned_at });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// Libera a conversa explicitamente (ex.: ao fechar a aba/trocar de conversa).
app.post('/api/leads/:id/release', async (req, res) => {
    const { id } = req.params;
    const username = req.user.username;
    try {
        await queryD1(
            `UPDATE leads SET owner_id = NULL, assigned_at = NULL WHERE id = ? AND owner_id = ?`,
            [id, username]
        );
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// Transfere a conversa pra outro atendente por escolha própria de quem está com ela agora
// (handoff deliberado — diferente da expiração automática por inatividade). Só quem é dono
// da conversa no momento pode ceder, e só pra um usuário que realmente existe no sistema.
app.post('/api/leads/:id/transfer', async (req, res) => {
    const { id } = req.params;
    const { to } = req.body;
    const username = req.user.username;

    if (!to || typeof to !== 'string') {
        return res.status(400).json({ error: 'Informe pra quem transferir a conversa.' });
    }
    if (to === username) {
        return res.status(400).json({ error: 'Você já está com essa conversa.' });
    }

    try {
        const targetUserRows = await queryD1('SELECT username FROM crm_users WHERE username = ?', [to]);
        if (!targetUserRows || targetUserRows.length === 0) {
            return res.status(404).json({ error: 'Esse usuário não existe.' });
        }

        await queryD1(
            `UPDATE leads SET owner_id = ?, assigned_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?`,
            [to, id, username]
        );

        const rows = await queryD1('SELECT id, owner_id, assigned_at FROM leads WHERE id = ?', [id]);
        const lead = rows && rows[0];
        if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });

        if (lead.owner_id === to) {
            return res.json({ success: true, owner_id: lead.owner_id, assigned_at: lead.assigned_at });
        }
        return res.status(409).json({ error: 'Você não está mais com essa conversa pra poder transferir.', owner_id: lead.owner_id, assigned_at: lead.assigned_at });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// Espelho da Rota Serverless da Vercel para uso Local
app.post('/api/agendar', async (req, res) => {
    // Editar um agendamento já existente é restrito a administradores (mesma regra que a
    // interface já sugeria em app.js, agora também aplicada no servidor).
    if (req.body && req.body.attendance_id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradores podem editar um agendamento existente.' });
    }

    const AMIGO_API_TOKEN = await getAmigoToken(req.body.unidade_id);
    if (!AMIGO_API_TOKEN) {
        return res.status(500).json({ error: 'Token não configurado no arquivo .env local.' });
    }

    const payload = req.body;
    
    // Convertendo os dados do CRM para o formato estrito do Amigo App
    const rawPhone = payload.patient_phone || payload.phone || '';
    
    let nameParts = (payload.patient_name || '').trim().split(' ');
    let firstName = nameParts[0] || 'Desconhecido';
    
    let lastName = '';
    if (payload.patient_id) {
        lastName = nameParts.slice(1).join(' ');
    } else {
        lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') + ' [MKT]' : '[MKT]';
    }

    const amigoPayload = {
        start_date: `${payload.appointment_date} ${payload.appointment_time}`,
        place_id: parseInt(payload.place_id) || 32337,
        event_id: parseInt(payload.event_id) || 176910,
        user_id: parseInt(payload.user_id) || 102962,
        observation: "Origem: CRM de Vendas/Marketing",
        patient: {
            name: firstName,
            last_name: lastName,
            cellphone: rawPhone.replace(/\D/g, ''),
            contact_cellphone: rawPhone.replace(/\D/g, ''),
            phone: rawPhone.replace(/\D/g, ''),
            born: payload.patient_born || "1990-01-01",
            email: payload.patient_email || ''
        }
    };
    
    if (payload.patient_id) {
        amigoPayload.patient.id = parseInt(payload.patient_id);
    }
    
    try {
        const endpoint = payload.attendance_id 
            ? `https://amigobot-api.amigoapp.com.br/attendances/${payload.attendance_id}`
            : 'https://amigobot-api.amigoapp.com.br/attendances';
        const method = payload.attendance_id ? 'PUT' : 'POST';

        const response = await fetch(endpoint, {
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${AMIGO_API_TOKEN}`
            },
            body: JSON.stringify(amigoPayload)
        });
        
        let data = {};
        try { data = await response.json(); } catch(e) {}
        
        if (!response.ok) {
            console.error("Erro da API do Amigo:", data);
            if (method === 'PUT' && data.message && data.message.includes("Status deve ser")) {
                throw new Error('O Amigo App bloqueia o reagendamento por ferramentas externas. Para mudar o horário ou dados, altere diretamente no site do Amigo App, ou cancele este agendamento e crie um novo.');
            }
            throw new Error(data?.message?.message || data.message || 'Erro ao agendar/atualizar no Amigo App');
        }
        
        // --- SALVANDO DADOS FINANCEIROS NO D1 ---
        try {
            const finalAttendanceId = String(payload.attendance_id || data.id || data?.data?.id || '') || null;

            // Se já existe registro para este lead_id (criado pelo drag-and-drop),
            // atualiza-o com os dados completos do agendamento ao invés de criar duplicata
            let updated = false;
            if (payload.lead_id) {
                const existing = await queryD1(
                    `SELECT id FROM agendamentos_financeiro WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1`,
                    [payload.lead_id]
                );
                if (existing && existing.length > 0) {
                    await queryD1(`
                        UPDATE agendamentos_financeiro
                        SET data_agendamento = ?,
                            nome_paciente = ?,
                            procedimento = ?,
                            unidade = ?,
                            origem = ?,
                            valor_primario = ?,
                            valor_secundario = ?,
                            status_pagamento = ?,
                            agendado_por = ?,
                            attendance_id = ?
                        WHERE id = ?
                    `, [
                        amigoPayload.start_date,
                        payload.patient_name,
                        payload.procedure_name || payload.event_id,
                        payload.place_name || payload.place_id,
                        payload.origem || 'Orgânico',
                        payload.valor_primario || '',
                        payload.valor_secundario || '',
                        payload.status_pagamento || 'Pendente',
                        payload.agendado_por || 'Sistema',
                        finalAttendanceId,
                        existing[0].id
                    ]);
                    updated = true;
                }
            }

            if (!updated) {
                await queryD1(`
                    INSERT INTO agendamentos_financeiro (
                        lead_id, data_agendamento, nome_paciente, procedimento, unidade,
                        origem, valor_primario, valor_secundario, status_pagamento, agendado_por, attendance_id
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    payload.lead_id || null,
                    amigoPayload.start_date,
                    payload.patient_name,
                    payload.procedure_name || payload.event_id,
                    payload.place_name || payload.place_id,
                    payload.origem || 'Orgânico',
                    payload.valor_primario || '',
                    payload.valor_secundario || '',
                    payload.status_pagamento || 'Pendente',
                    payload.agendado_por || 'Sistema',
                    finalAttendanceId
                ]);
            }
        } catch (e) {
            console.error("Erro ao salvar histórico financeiro no D1:", e);
        }
        
        // --- ENVIO META CAPI (AGENDAMENTO) ---
        if (!payload.attendance_id) {
            sendMetaCapiEvent('Schedule', {
                telefone: payload.patient_phone,
                email: payload.patient_email,
                fb_click_id: payload.fb_click_id
            });
        }
        
        res.status(200).json({ 
            success: true, 
            message: payload.attendance_id ? 'Agendamento atualizado com sucesso!' : 'Agendamento criado via API Real do Amigo App!' 
        });
    } catch (error) {
        res.status(400).json({ error: error.message, details: error.message });
    }
});

// Deletar um lead
app.delete('/api/leads/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await queryD1('DELETE FROM leads WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ==== PÚBLICOS SALVOS (recortes de leads reaproveitados no disparo de campanha) ====
app.get('/api/audiences', async (req, res) => {
    try {
        const rows = await queryD1('SELECT * FROM lead_audiences ORDER BY created_at DESC');
        res.json({ success: true, data: rows || [] });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

app.post('/api/audiences', async (req, res) => {
    const { name, owner_id, origem, date_start, date_end, has_schedule } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Nome do público é obrigatório.' });
    }
    try {
        const id = Date.now().toString();
        await queryD1(
            'INSERT INTO lead_audiences (id, name, owner_id, origem, date_start, date_end, has_schedule) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [id, name.trim(), owner_id || '', origem || '', date_start || '', date_end || '', has_schedule ? 1 : 0]
        );
        res.status(201).json({ success: true, id });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

app.delete('/api/audiences/:id', async (req, res) => {
    try {
        await queryD1('DELETE FROM lead_audiences WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// Nova Rota Local para buscar Opções Dinâmicas (Serviços, Médicos, Locais)
app.get('/api/options', async (req, res) => {
    const AMIGO_API_TOKEN = await getAmigoToken(req.query.unidade_id);
    if (!AMIGO_API_TOKEN) return res.status(500).json({ error: 'Token ausente' });
    
    const headers = { 'Authorization': `Bearer ${AMIGO_API_TOKEN}` };
    
    try {
        // Fallback inteligente: Vamos buscar os agendamentos dos ultimos 30 dias até 30 dias pra frente
        // Para extrair os procedimentos que já foram usados, já que a API /events as vezes oculta.
        const today = new Date();
        const past = new Date(today); past.setDate(today.getDate() - 90);
        const future = new Date(today); future.setDate(today.getDate() + 90);
        
        const startPast = past.toISOString().split('T')[0];
        const endPast = today.toISOString().split('T')[0];
        
        const startFuture = today.toISOString().split('T')[0];
        const endFuture = future.toISOString().split('T')[0];
        
        const [placesRes, eventsRes, docsRes, attPastRes, attFutureRes, localProceduresRes] = await Promise.all([
            fetch('https://amigobot-api.amigoapp.com.br/places', { headers }),
            fetch('https://amigobot-api.amigoapp.com.br/events', { headers }),
            fetch('https://amigobot-api.amigoapp.com.br/doctors', { headers }),
            fetch(`https://amigobot-api.amigoapp.com.br/attendances?start_date=${startPast}&end_date=${endPast}&status=ALL`, { headers }),
            fetch(`https://amigobot-api.amigoapp.com.br/attendances?start_date=${startFuture}&end_date=${endFuture}&status=ALL`, { headers }),
            queryD1('SELECT DISTINCT procedimento FROM agendamentos_financeiro WHERE procedimento IS NOT NULL AND procedimento != ""')
        ]);
        
        const places = await placesRes.json();
        const eventsAPI = await eventsRes.json();
        const docs = await docsRes.json();
        const attPast = await attPastRes.json();
        const attFuture = await attFutureRes.json();
        
        const attendances = { data: [...(attPast.data || []), ...(attFuture.data || [])] };
        
        // Extraindo eventos da agenda
        const eventsMap = new Map();
        (eventsAPI.data || []).forEach(e => eventsMap.set(e.id, { id: e.id, name: e.name }));
        
        // Inserir os procedimentos registrados localmente no banco de dados
        (localProceduresRes || []).forEach(row => {
            if (row.procedimento) {
                // Usando o nome como chave para evitar duplicatas. O ID pode ser um timestamp fake pois não temos o ID real.
                const nameUpper = row.procedimento.trim().toUpperCase();
                let found = false;
                for (const [key, val] of eventsMap.entries()) {
                    if (val.name.trim().toUpperCase() === nameUpper) {
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    const fakeId = 9000000 + Math.floor(Math.random() * 100000);
                    eventsMap.set(fakeId, { id: fakeId, name: row.procedimento.trim() });
                }
            }
        });
        
        // Extraindo profissionais da agenda (para garantir que todos apareçam)
        const doctorsMap = new Map();
        (docs.data || []).forEach(d => doctorsMap.set(d.id, { id: d.id, name: d.name }));

        (attendances.data || []).forEach(att => {
            if (att.agenda_event && att.agenda_event.id) {
                if (!eventsMap.has(att.agenda_event.id)) {
                    eventsMap.set(att.agenda_event.id, { id: att.agenda_event.id, name: att.agenda_event.name });
                }
            }
            if (att.user && att.user.id) {
                if (!doctorsMap.has(att.user.id)) {
                    doctorsMap.set(att.user.id, { id: att.user.id, name: att.user.name });
                }
            }
        });
        
        res.status(200).json({
            places: places.data || [],
            events: Array.from(eventsMap.values()),
            doctors: Array.from(doctorsMap.values())
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro interno' });
    }
});

// Rota para calcular horários livres
app.get('/api/availability', async (req, res) => {
    try {
        const { user_id, date } = req.query;
        if (!user_id || !date) return res.status(400).json({ error: "Faltam parâmetros" });
        
        const url = `https://amigobot-api.amigoapp.com.br/attendances?start_date=${date}&end_date=${date}&status=ALL&limit=100`;
        const response = await fetch(url, { headers: { 'Authorization': 'Bearer ' + process.env.AMIGO_API_TOKEN } });
        if (!response.ok) throw new Error("Erro na API Amigo");
        
        const j = await response.json();
        const allAttendances = j.data || [];
        // Filtramos pelo médico manualmente caso a query user_id da api falhe
        const attendances = allAttendances.filter(a => String(a.user?.id) === String(user_id));
        // Identificar se é sábado
        const dayOfWeek = new Date(date + 'T12:00:00Z').getUTCDay();
        const endHour = (dayOfWeek === 6) ? 12 : 18; // Sábado até 12h, dias normais até 18h
        
        const freeSlots = [];
        for (let h=8; h<endHour; h++) {
            for (let m=0; m<60; m+=30) {
                const hourStr = h.toString().padStart(2, '0');
                const minStr = m.toString().padStart(2, '0');
                const timeStr = `${hourStr}:${minStr}`;
                
                const slotTime = h * 60 + m;
                let isFree = true;
                
                for (let att of attendances) {
                    if (att.status === 'canceled' || att.status === 'rescheduled') continue;
                    
                    const dStart = new Date(att.start_date);
                    const dEnd = att.end_date ? new Date(att.end_date) : new Date(dStart.getTime() + 60*60*1000);
                    
                    const attStart = dStart.getUTCHours() * 60 + dStart.getUTCMinutes();
                    const attEnd = dEnd.getUTCHours() * 60 + dEnd.getUTCMinutes();
                    
                    if (slotTime >= attStart && slotTime < attEnd) {
                        isFree = false;
                        break;
                    }
                }
                if (isFree) freeSlots.push(timeStr);
            }
        }
        res.status(200).json({ slots: freeSlots });
    } catch(e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ==== REGISTRAR ARRASTAMENTO NO HISTÓRICO (DRAG → QUALQUER COLUNA) ====
app.post('/api/registrar-no-historico', async (req, res) => {
    try {
        const { lead_id, nome_paciente, procedimento, origem, valor_primario, agendado_por, status_pagamento } = req.body;
        if (!nome_paciente) {
            return res.status(400).json({ error: 'nome_paciente é obrigatório' });
        }

        const statusFinal = status_pagamento || 'Pendente';

        // Se já existe um registro para este lead_id, ATUALIZA o status ao invés de criar duplicata
        if (lead_id) {
            const existing = await queryD1(
                `SELECT id FROM agendamentos_financeiro WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1`,
                [lead_id]
            );
            if (existing && existing.length > 0) {
                await queryD1(
                    `UPDATE agendamentos_financeiro SET status_pagamento = ?, valor_primario = CASE WHEN ? != '' THEN ? ELSE valor_primario END WHERE id = ?`,
                    [statusFinal, valor_primario || '', valor_primario || '', existing[0].id]
                );
                return res.json({ success: true, updated: true });
            }
        }

        const dataAgendamento = new Date().toISOString().replace('T', ' ').slice(0, 19);

        await queryD1(`
            INSERT INTO agendamentos_financeiro (
                lead_id, data_agendamento, nome_paciente, procedimento, unidade,
                origem, valor_primario, valor_secundario, status_pagamento, agendado_por
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            lead_id || null,
            dataAgendamento,
            nome_paciente,
            procedimento || 'A definir',
            '',
            origem || 'Orgânico',
            valor_primario || '',
            '',
            statusFinal,
            agendado_por || 'Sistema'
        ]);

        res.json({ success: true });
    } catch(e) {
        console.error('Erro ao registrar no histórico:', e);
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ==== ATUALIZAR STATUS DE PAGAMENTO DO AGENDAMENTO ====
app.patch('/api/historico-financeiro/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status_pagamento } = req.body;
        if (!status_pagamento) {
            return res.status(400).json({ error: "status_pagamento é obrigatório" });
        }
        await queryD1('UPDATE agendamentos_financeiro SET status_pagamento = ? WHERE id = ?', [status_pagamento, id]);
        res.json({ success: true });
    } catch(e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ==== EDITAR REGISTRO DO HISTÓRICO ====
// ==== CRIAR/ATUALIZAR DADOS FINANCEIROS DE UM AGENDAMENTO VINDO DIRETO DO AMIGO APP ====
// Usado quando o agendamento existe no Amigo App mas ainda não tem registro financeiro local
// (nunca foi criado por este CRM). Faz upsert por attendance_id.
app.post('/api/historico-financeiro', async (req, res) => {
    try {
        const { attendance_id, data_agendamento, nome_paciente, procedimento, unidade, origem, valor_primario, valor_secundario, status_pagamento } = req.body;
        if (!attendance_id) {
            return res.status(400).json({ error: 'attendance_id é obrigatório.' });
        }

        const existing = await queryD1('SELECT id FROM agendamentos_financeiro WHERE attendance_id = ? LIMIT 1', [String(attendance_id)]);

        if (existing && existing.length > 0) {
            const fields = { data_agendamento, nome_paciente, procedimento, unidade, origem, valor_primario, valor_secundario, status_pagamento };
            const updates = [];
            const params = [];
            Object.entries(fields).forEach(([key, value]) => {
                if (value !== undefined) { updates.push(`${key} = ?`); params.push(value); }
            });
            if (updates.length > 0) {
                params.push(existing[0].id);
                await queryD1(`UPDATE agendamentos_financeiro SET ${updates.join(', ')} WHERE id = ?`, params);
            }
            return res.json({ success: true, id: existing[0].id });
        }

        await queryD1(`
            INSERT INTO agendamentos_financeiro (
                attendance_id, data_agendamento, nome_paciente, procedimento, unidade,
                origem, valor_primario, valor_secundario, status_pagamento, agendado_por
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            String(attendance_id),
            data_agendamento || '',
            nome_paciente || '',
            procedimento || '',
            unidade || '',
            origem || 'Orgânico',
            valor_primario || '',
            valor_secundario || '',
            status_pagamento || 'Pendente',
            (req.user && req.user.username) || 'Sistema'
        ]);

        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

app.put('/api/historico-financeiro/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { data_agendamento, nome_paciente, procedimento, unidade, origem, valor_primario, valor_secundario } = req.body;
        
        await queryD1(`
            UPDATE agendamentos_financeiro 
            SET data_agendamento = ?, 
                nome_paciente = ?, 
                procedimento = ?, 
                unidade = ?, 
                origem = ?, 
                valor_primario = ?, 
                valor_secundario = ?
            WHERE id = ?
        `, [data_agendamento, nome_paciente, procedimento, unidade, origem, valor_primario, valor_secundario, id]);
        
        res.json({ success: true });
    } catch(e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ==== DELETAR REGISTRO DO HISTÓRICO ====
app.delete('/api/historico-financeiro/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await queryD1('DELETE FROM agendamentos_financeiro WHERE id = ?', [id]);
        res.json({ success: true });
    } catch(e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ==== ROTA PARA HISTÓRICO FINANCEIRO (JSON) ====
// ==========================================
// HELPER: Lista completa de agendamentos (Amigo App ao vivo + dados financeiros locais)
// ==========================================
async function getMergedAgendamentos(startDate, endDate) {
    const AMIGO_API_TOKEN = process.env.AMIGO_API_TOKEN;
    if (!AMIGO_API_TOKEN) throw new Error('Token do Amigo App não configurado.');
    const headers = { 'Authorization': `Bearer ${AMIGO_API_TOKEN}` };

    // A API do Amigo App rejeita (400 VALIDATION_ERROR) qualquer intervalo maior que 90 dias.
    // Se o período pedido for maior, busca só os últimos 90 dias até endDate — os agendamentos
    // locais (agendamentos_financeiro) fora dessa janela continuam aparecendo normalmente logo
    // abaixo, só os que vêm direto do Amigo App é que ficam de fora da parte excedente.
    const AMIGO_MAX_RANGE_DAYS = 90;
    let amigoStartDate = startDate;
    const daysBetween = (Date.parse(endDate) - Date.parse(startDate)) / (1000 * 60 * 60 * 24);
    if (daysBetween > AMIGO_MAX_RANGE_DAYS) {
        const clamped = new Date(endDate);
        clamped.setDate(clamped.getDate() - AMIGO_MAX_RANGE_DAYS);
        amigoStartDate = clamped.toISOString().split('T')[0];
    }

    const [attRes, placesRes, localRows] = await Promise.all([
        fetch(`https://amigobot-api.amigoapp.com.br/attendances?start_date=${amigoStartDate}&end_date=${endDate}&status=ALL`, { headers }),
        fetch('https://amigobot-api.amigoapp.com.br/places', { headers }),
        queryD1('SELECT * FROM agendamentos_financeiro')
    ]);

    const attJson = await attRes.json().catch(() => ({}));
    if (!attRes.ok) {
        const msg = typeof attJson.message === 'string' ? attJson.message : JSON.stringify(attJson.message || attJson);
        throw new Error(msg || 'Erro ao consultar agendamentos no Amigo App');
    }
    const attendances = attJson.data || [];

    const placesJson = await placesRes.json().catch(() => ({}));
    const placesMap = new Map();
    (placesJson.data || []).forEach(p => placesMap.set(p.id, p.name));

    // Indexa os registros financeiros locais por attendance_id (agendamentos feitos por este CRM)
    const localByAttendanceId = new Map();
    (localRows || []).forEach(row => {
        if (row.attendance_id) localByAttendanceId.set(String(row.attendance_id), row);
    });

    const merged = attendances.map(att => {
        const local = localByAttendanceId.get(String(att.id));
        return {
            id: local ? local.id : null,
            attendance_id: att.id,
            data_agendamento: (att.start_date || '').replace('T', ' '),
            nome_paciente: att.patient?.name || '-',
            telefone_paciente: att.patient?.contact_cellphone || att.patient?.cellphone || '',
            procedimento: att.agenda_event?.name || (local ? local.procedimento : '') || 'A definir',
            unidade: att.place?.name || placesMap.get(att.place?.id) || (local ? local.unidade : '') || '-',
            origem: (local && local.origem) || 'Amigo App (direto)',
            valor_primario: (local && local.valor_primario) || '',
            valor_secundario: (local && local.valor_secundario) || '',
            status_pagamento: (local && local.status_pagamento) || 'Pendente',
            agendado_por: (local && local.agendado_por) || '-'
        };
    });

    // Registros financeiros locais sem vínculo a um attendance do Amigo App (ex: negócio
    // fechado direto pelo Kanban, sem agendamento formal) — não têm como aparecer na lista
    // acima, então são incluídos à parte pra não sumirem do relatório.
    (localRows || []).forEach(row => {
        if (row.attendance_id) return; // já é tratado pelo cruzamento com o Amigo App acima
        const rowDateOnly = (row.data_agendamento || '').split(' ')[0];
        if (rowDateOnly && (rowDateOnly < startDate || rowDateOnly > endDate)) return;
        merged.push({
            id: row.id,
            attendance_id: row.attendance_id || null,
            data_agendamento: row.data_agendamento || '',
            nome_paciente: row.nome_paciente || '-',
            telefone_paciente: '',
            procedimento: row.procedimento || 'A definir',
            unidade: row.unidade || '-',
            origem: row.origem || 'Orgânico',
            valor_primario: row.valor_primario || '',
            valor_secundario: row.valor_secundario || '',
            status_pagamento: row.status_pagamento || 'Pendente',
            agendado_por: row.agendado_por || '-'
        });
    });

    return merged.sort((a, b) => new Date(b.data_agendamento) - new Date(a.data_agendamento));
}

app.get('/api/historico-financeiro', async (req, res) => {
    try {
        const today = new Date();
        // 90 dias por padrão: é o teto que a própria API do Amigo App aceita por consulta.
        const defaultStart = new Date(today); defaultStart.setDate(defaultStart.getDate() - 90);

        const startDate = req.query.start || defaultStart.toISOString().split('T')[0];
        const endDate = req.query.end || today.toISOString().split('T')[0];

        const merged = await getMergedAgendamentos(startDate, endDate);
        res.json(merged);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message || 'Erro interno do servidor.' });
    }
});

// ==== ROTA PARA EXPORTAR PLANILHA CSV ====
app.get('/api/export-csv', async (req, res) => {
    try {
        const today = new Date();
        // 90 dias por padrão: é o teto que a própria API do Amigo App aceita por consulta.
        const defaultStart = new Date(today); defaultStart.setDate(defaultStart.getDate() - 90);

        const startDate = req.query.start || defaultStart.toISOString().split('T')[0];
        const endDate = req.query.end || today.toISOString().split('T')[0];

        const rows = await getMergedAgendamentos(startDate, endDate);

        // Cabeçalho da planilha (Separado por Ponto e Vírgula para Excel PT-BR)
        let csvContent = 'DATA;Nome;Telefone;Procedimento;Unidade;Origem;Valor primário;Valor secundário;Status;Agendado por:\n';

        rows.forEach(row => {
            const rowData = [
                row.data_agendamento,
                row.nome_paciente,
                row.telefone_paciente,
                row.procedimento,
                row.unidade,
                row.origem,
                row.valor_primario,
                row.valor_secundario,
                row.status_pagamento,
                row.agendado_por
            ].map(v => `"${(v || '').toString().replace(/"/g, '""')}"`); // Escapa aspas duplas

            csvContent += rowData.join(';') + '\n';
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="historico_financeiro.csv"');
        res.send('\uFEFF' + csvContent); // \uFEFF adiciona BOM para Excel reconhecer acentos UTF-8
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message || 'Erro interno do servidor.' });
    }
});

// ============================================
// NOVA ROTA: RELACIONAMENTO (CRM ATIVO)
// ============================================
app.get('/api/relacionamento', async (req, res) => {
    try {
        const AMIGO_API_TOKEN = process.env.AMIGO_API_TOKEN;
        const headers = { 'Authorization': `Bearer ${AMIGO_API_TOKEN}` };
        const today = new Date();
        
        // Pega string formato YYYY-MM-DD local
        const getStr = (d) => {
            const offset = d.getTimezoneOffset() * 60000;
            return (new Date(d - offset)).toISOString().split('T')[0];
        };

        // Janela 1: Hoje até 60 dias atrás
        const d1End = new Date(today);
        const d1Start = new Date(today); d1Start.setDate(d1Start.getDate() - 60);
        
        // Janela 2: 60 dias atrás até 120 dias atrás
        const d2End = new Date(d1Start); d2End.setDate(d2End.getDate() - 1);
        const d2Start = new Date(d2End); d2Start.setDate(d2Start.getDate() - 60);
        
        // Janela 3: Hoje até 30 dias no futuro (para saber se já estão agendados)
        const d3Start = new Date(today);
        const d3End = new Date(today); d3End.setDate(d3End.getDate() + 30);

        const promises = [
            fetch(`https://amigobot-api.amigoapp.com.br/attendances?start_date=${getStr(d1Start)}&end_date=${getStr(d1End)}&status=ALL`, { headers }),
            fetch(`https://amigobot-api.amigoapp.com.br/attendances?start_date=${getStr(d2Start)}&end_date=${getStr(d2End)}&status=ALL`, { headers }),
            fetch(`https://amigobot-api.amigoapp.com.br/attendances?start_date=${getStr(d3Start)}&end_date=${getStr(d3End)}&status=ALL`, { headers })
        ];

        const responses = await Promise.all(promises);
        let allAttendances = [];
        for (let r of responses) {
            if (r.ok) {
                const j = await r.json();
                if (j.data) allAttendances = allAttendances.concat(j.data);
            }
        }

        // Processar Pacientes
        const patientsMap = new Map();
        const currentMonth = today.getMonth() + 1;
        
        allAttendances.forEach(att => {
            if (!att.patient || !att.patient.id) return;
            const pid = att.patient.id;
            
            if (!patientsMap.has(pid)) {
                patientsMap.set(pid, {
                    id: pid,
                    name: att.patient.name,
                    phone: att.patient.contact_cellphone || '',
                    attendances: []
                });
            }
            patientsMap.get(pid).attendances.push(att);
        });

        const result = {
            pos_venda: [],
            faltantes: [],
            sumidos: []
        };
        
        // ===============================================
        // BUSCAR MENSAGENS ENVIADAS DO CLOUDFLARE D1
        // ===============================================
        let contactedMap = {};
        try {
            // Busca mensagens dos ultimos 30 dias
            const rows = await queryD1('SELECT paciente_id, tipo FROM mensagens_enviadas WHERE data_envio > datetime("now", "-30 days")');
            rows.forEach(r => {
                if (!contactedMap[r.paciente_id]) contactedMap[r.paciente_id] = {};
                contactedMap[r.paciente_id][r.tipo] = true;
            });
        } catch(e) {
            console.error("D1: Não foi possível carregar o histórico de mensagens", e.message);
        }

        const nowMs = today.getTime();

        Array.from(patientsMap.values()).forEach(p => {
            // Ordenar atendimentos do mais recente para o mais antigo
            p.attendances.sort((a, b) => new Date(b.start_date) - new Date(a.start_date));
            
            let hasFuture = false;
            let lastPastAtt = null;
            let lastMissedOrCanceled = null;
            
            p.attendances.forEach(att => {
                const attDate = new Date(att.start_date);
                if (attDate > today) {
                    hasFuture = true;
                } else {
                    if (att.status === 'canceled' || att.status === 'missed') {
                        if (!lastMissedOrCanceled || attDate > new Date(lastMissedOrCanceled.start_date)) {
                            lastMissedOrCanceled = att;
                        }
                    } else if (att.status === 'done' || att.status === 'arrived') {
                        if (!lastPastAtt || attDate > new Date(lastPastAtt.start_date)) {
                            lastPastAtt = att;
                        }
                    }
                }
            });

            // 1. Faltantes (Cancelados ou Missed nos últimos 15 dias)
            if (lastMissedOrCanceled) {
                const diffMissed = (nowMs - new Date(lastMissedOrCanceled.start_date).getTime()) / (1000 * 60 * 60 * 24);
                if (diffMissed <= 15) {
                    result.faltantes.push({
                        patient: p,
                        last_attendance: lastMissedOrCanceled,
                        contacted: !!(contactedMap[String(p.id)] && contactedMap[String(p.id)]['faltantes'])
                    });
                }
            }

            if (!lastPastAtt) return; // Se não tem histórico passado de sucesso, ignora pro resto

            const diffDays = (nowMs - new Date(lastPastAtt.start_date).getTime()) / (1000 * 60 * 60 * 24);

            // 2. Pós Venda (Últimos 7 a 15 dias)
            if (diffDays >= 7 && diffDays <= 15) {
                result.pos_venda.push({
                    patient: p,
                    last_attendance: lastPastAtt,
                    contacted: !!(contactedMap[String(p.id)] && contactedMap[String(p.id)]['pos_venda'])
                });
            }

            // 3. Sumidos (45 a 120 dias atrás) E não tem agendamento futuro
            if (!hasFuture && diffDays >= 45 && diffDays <= 120) {
                result.sumidos.push({
                    patient: p,
                    last_attendance: lastPastAtt,
                    days_absent: Math.floor(diffDays),
                    contacted: !!(contactedMap[String(p.id)] && contactedMap[String(p.id)]['sumidos'])
                });
            }
        });

        // Removemos o limitador antigo de 50 itens para enviar todos os pacientes encontrados


        res.status(200).json(result);
    } catch (error) {
        console.error("Erro Relacionamento:", error);
        console.error(error);
        res.status(500).json({ error: 'Erro interno' });
    }
});

// --- ROTAS DE ANIVERSARIANTES ---
app.get('/api/aniversariantes', async (req, res) => {
    try {
        const today = new Date();
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const dd = String(today.getDate()).padStart(2, '0');
        const dateStr = `${mm}-${dd}`;

        const amigoToken = process.env.AMIGO_API_TOKEN;
        if (!amigoToken) throw new Error("AMIGO_API_TOKEN não configurado no .env");

        const response = await fetch(`https://amigobot-api.amigoapp.com.br/patients/birthday?date=${dateStr}`, {
            headers: {
                'Authorization': `Bearer ${amigoToken}`
            }
        });

        if (!response.ok) {
            throw new Error(`Erro na API do Amigo App: ${response.statusText}`);
        }

        const data = await response.json();
        
        let found = [];
        if (data && data.data && Array.isArray(data.data)) {
            // Transformar os dados para o padrão que o front-end espera
            found = data.data.map(p => {
                return {
                    name: p.name,
                    phone: p.contact_cellphone ? (p.contact_cellphone_dial_code || '55') + p.contact_cellphone : '',
                    age: p.age,
                    isToday: true // Como filtramos para hoje, todos são hoje
                };
            });
        }

        res.status(200).json({ aniversariantes: found });
    } catch (error) {
        console.error("Erro Aniversariantes API:", error);
        res.status(500).json({ error: 'Erro ao buscar aniversariantes na API' });
    }
});

// Leitura da Planilha para o mês todo — vem do D1, não mais de um CSV em disco
app.get('/api/aniversariantes/month', async (req, res) => {
    try {
        const rows = await queryD1('SELECT nome, data_nasc, celular FROM aniversariantes');

        const currentMonth = new Date().getMonth() + 1;
        const currentDay = new Date().getDate();
        let found = [];

        for (const row of rows) {
            const nome = (row.nome || '').trim();
            const dataNascStr = (row.data_nasc || '').trim();
            const celular = row.celular || '';

            if (!nome || !dataNascStr) continue;

            const dateParts = dataNascStr.split('/');
            if (dateParts.length === 3) {
                const bDay = parseInt(dateParts[0], 10);
                const bMonth = parseInt(dateParts[1], 10);

                if (bMonth === currentMonth) {
                    found.push({
                        name: nome,
                        phone: celular,
                        birthDate: dataNascStr,
                        day: bDay,
                        isToday: (bDay === currentDay)
                    });
                }
            }
        }

        found.sort((a, b) => a.day - b.day);
        res.status(200).json({ aniversariantes: found });
    } catch (error) {
        console.error("Erro Aniversariantes Mês:", error);
        res.status(500).json({ error: 'Erro ao processar dados de aniversariantes' });
    }
});

// Upload via memória: a planilha é parseada e gravada direto no D1, nunca no disco.
// Só nome, data de nascimento e celular são guardados — CPF, e-mail e dados
// financeiros da planilha são descartados por não serem usados por essa funcionalidade.
const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/aniversariantes/upload', upload.single('csvFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
        }

        const csvText = req.file.buffer.toString('latin1');
        const lines = csvText.split('\n');
        const parsed = [];

        for (let i = 1; i < lines.length; i++) {
            const row = lines[i].split(';');
            if (row.length < 8) continue;

            const idAmigo = row[0]?.trim();
            const nome = row[1]?.trim();
            const dataNasc = row[3]?.trim();
            const celular = row[7]?.trim() || '';

            if (!idAmigo || !nome || !dataNasc) continue;
            parsed.push([idAmigo, nome, dataNasc, celular]);
        }

        await queryD1('DELETE FROM aniversariantes');

        const CHUNK_SIZE = 20; // D1 rejeita lotes maiores por limite de variáveis por query
        for (let i = 0; i < parsed.length; i += CHUNK_SIZE) {
            const chunk = parsed.slice(i, i + CHUNK_SIZE);
            const placeholders = chunk.map(() => '(?, ?, ?, ?)').join(', ');
            const params = chunk.flat();
            await queryD1(`INSERT INTO aniversariantes (id_amigo, nome, data_nasc, celular) VALUES ${placeholders}`, params);
        }

        res.status(200).json({ success: true, message: `Planilha atualizada com sucesso! ${parsed.length} pacientes importados.` });
    } catch (error) {
        console.error("Erro no upload:", error);
        res.status(500).json({ error: 'Falha ao salvar a planilha.' });
    }
});

// ==== RADAR DE NOTIFICAÇÕES (POLLING) ====
const notifiedAttendances = new Set();
if (!process.env.VERCEL) {
    setInterval(async () => {
        try {
            const AMIGO_API_TOKEN = process.env.AMIGO_API_TOKEN;
            if (!AMIGO_API_TOKEN) return;
            
            const d = new Date().toISOString().split('T')[0];
            const res = await fetch(`https://amigobot-api.amigoapp.com.br/attendances?start_date=${d}&end_date=${d}&status=ALL`, {
                headers: { 'Authorization': `Bearer ${AMIGO_API_TOKEN}` }
            });
            const json = await res.json();
            const attendances = json.data || [];
            
            for (let att of attendances) {
                if (att.status === 'done' && !notifiedAttendances.has(att.id)) {
                    notifiedAttendances.add(att.id);
                    const pName = att.patient?.name || 'Um paciente';
                    const msg = `✅ O atendimento de ${pName} foi finalizado com sucesso!`;
                    
                    await queryD1(
                        'INSERT INTO crm_notifications (id, message, created_at) VALUES (?, ?, ?)',
                        [Date.now().toString() + Math.random(), msg, att.start_date || new Date().toISOString()]
                    );
                }
            }
        } catch (e) {
            console.error("Erro no radar de notificações:", e.message);
        }
    }, 5 * 60 * 1000);
}

// Iniciar Servidor (Sempre roda localmente, exceto na Vercel)
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`✅ Servidor Local de Desenvolvimento Rodando!`);
        console.log(`👉 Acesse no seu navegador: http://localhost:${PORT}\n`);
    });
}

// Necessário para a Vercel interpretar o Express Serverless
export default app;
