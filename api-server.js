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
import webpush from 'web-push';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// Confirma no boot que o binário do ffmpeg existe e é executável — a conversão de
// áudio pra "voice note" do WhatsApp depende dele. Se faltar (ex.: bundle da
// Vercel não incluiu o binário), a gravação ainda é enviada, mas como anexo
// comum, e sem esse log ninguém descobre o porquê.
try {
    fs.accessSync(ffmpegInstaller.path, fs.constants.X_OK);
    console.log('[audio] ffmpeg disponível em', ffmpegInstaller.path);
} catch (e) {
    console.warn('[audio] ffmpeg NÃO disponível/executável em', ffmpegInstaller.path,
        '— gravações de voz serão enviadas como anexo, sem forma de onda nativa. Detalhe:', e.message);
}

// Sem estes handlers, QUALQUER erro solto (ex.: um 'error' de EventEmitter sem
// listener na conversão de áudio / upload) derruba o processo inteiro — e aí
// TODAS as conexões (SSE do kanban, polling do chat) caem com ERR_CONNECTION_RESET.
// Aqui a gente loga e mantém o servidor de pé.
process.on('uncaughtException', (err) => {
    console.error('!! uncaughtException — servidor mantido vivo:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('!! unhandledRejection — servidor mantido vivo:', reason);
});

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

// Alterna o 9º dígito de um celular BR (com <-> sem). Usado pra retry no erro
// 131026 da Meta: o wa_id que vem no webhook nem sempre é a forma que a Cloud
// API aceita pra ENVIO (inconsistência histórica do nono dígito no Brasil).
// Retorna null se não for um número BR reconhecível.
function toggleBR9(raw) {
    const d = String(raw || '').replace(/\D/g, '');
    if (!d.startsWith('55')) return null;
    const rest = d.slice(2);
    // com 9: 55 + DDD(2) + 9 + 8 dígitos (13 no total) -> remove o 9
    if (rest.length === 11 && rest[2] === '9') return '55' + rest.slice(0, 2) + rest.slice(3);
    // sem 9: 55 + DDD(2) + 8 dígitos (12 no total) -> adiciona o 9
    if (rest.length === 10) return '55' + rest.slice(0, 2) + '9' + rest.slice(2);
    return null;
}

// POST pro endpoint de mensagens da Meta, com retry no 131026 ("Message
// undeliverable"): se o número é um celular BR, repete UMA vez alternando o 9º
// dígito. Retorna { ok, resultJson, usedTo, switched } — usedTo é a forma que
// efetivamente funcionou (pode diferir do 'to' pedido).
async function postMetaMessage(phone_id, token, data) {
    const url = `https://graph.facebook.com/v20.0/${phone_id}/messages`;
    const doPost = async (payload) => {
        const r = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const j = await r.json().catch(() => ({}));
        return { r, j };
    };

    const first = await doPost(data);
    if (first.r.ok) return { ok: true, resultJson: first.j, usedTo: data.to, switched: false };

    const err = first.j && first.j.error;
    const undeliverable = (err && err.code === 131026) || /undeliverable/i.test((err && err.message) || '');
    const alt = undeliverable ? toggleBR9(data.to) : null;
    if (alt && alt !== data.to) {
        console.warn(`Meta 131026 pra ${data.to} — retry com ${alt}`);
        const retry = await doPost({ ...data, to: alt });
        if (retry.r.ok) return { ok: true, resultJson: retry.j, usedTo: alt, switched: true };
        return { ok: false, resultJson: retry.j, usedTo: alt, switched: false };
    }
    return { ok: false, resultJson: first.j, usedTo: data.to, switched: false };
}

// Quando a Meta aceitou o envio numa forma de número diferente da que estava
// salva (retry do 9º dígito, ou wa_id canônico devolvido em contacts[0].wa_id),
// migra o histórico do chat e o telefone do lead pra essa forma — assim os
// próximos envios já vão direto, sem o erro + retry, e a conversa não racha em
// dois threads.
async function migrateChatPhone(oldTo, newTo) {
    if (!newTo || newTo === oldTo) return;
    try {
        await queryD1('UPDATE wa_messages SET phone = ? WHERE phone = ?', [newTo, oldTo]);
        const cv = phoneVariants(oldTo);
        await queryD1(`UPDATE leads SET telefone = ? WHERE telefone IN (${cv.map(() => '?').join(', ')})`, [newTo, ...cv]);
        console.log(`WhatsApp: número migrado de ${oldTo} para ${newTo} (forma aceita pela Meta).`);
    } catch (e) { console.error('Falha ao migrar número do chat:', e.message); }
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
const PUBLIC_API_PATHS = new Set(['/login', '/ping', '/whatsapp/webhook', '/flow-tick', '/webhooks/psp']);

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
            
            // VERIFICAÇÃO DE BLOQUEIO (BLACKLIST NATIVA DO CRM)
            const blockedRows = await queryD1('SELECT is_blocked FROM crm_chat_settings WHERE phone = ?', [from]);
            if (blockedRows && blockedRows.length > 0 && blockedRows[0].is_blocked) {
                console.log(`Mensagem DESCARTADA: O número ${from} está bloqueado no CRM.`);
                return res.sendStatus(200); // Retorna 200 para a Meta não reenviar
            }

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
            
            // Mídia de "visualização única": a Cloud API não entrega o arquivo
            // (o id não vem). Mostra um aviso claro em vez de mídia quebrada.
            const isViewOnce = (o) => o && (o.view_once === true || o.view_once === 'true' || !o.id);
            const VIEW_ONCE_MSG = (icon, tipo) => `${icon} [${tipo} de visualização única — não disponível pela API. Peça pro paciente reenviar como ${tipo.toLowerCase()} normal.]`;

            if (msg_type === "text") {
                msg_body = message_obj.text ? message_obj.text.body : "";
            } else if (msg_type === "image") {
                if (isViewOnce(message_obj.image)) {
                    msg_body = VIEW_ONCE_MSG('📷', 'Foto');
                } else {
                    const mediaId = message_obj.image.id;
                    const caption = message_obj.image.caption || "";
                    msg_body = `[FILE:Imagem.jpg]/api/whatsapp/media/${mediaId}.jpg${caption ? `[CAPTION:${caption}]` : ''}`;
                }
            } else if (msg_type === "audio" || msg_type === "voice") {
                const audioObj = message_obj.audio || message_obj.voice;
                if (isViewOnce(audioObj)) {
                    msg_body = VIEW_ONCE_MSG('🎧', 'Áudio');
                } else {
                    const mediaId = audioObj.id;
                    msg_body = `[FILE:Áudio.ogg]/api/whatsapp/media/${mediaId}.ogg`;
                }
            } else if (msg_type === "video") {
                if (isViewOnce(message_obj.video)) {
                    msg_body = VIEW_ONCE_MSG('🎥', 'Vídeo');
                } else {
                    const mediaId = message_obj.video.id;
                    const caption = message_obj.video.caption || "";
                    msg_body = `[FILE:Vídeo.mp4]/api/whatsapp/media/${mediaId}.mp4${caption ? `[CAPTION:${caption}]` : ''}`;
                }
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
            } else if (msg_type === "button") {
                // Clique num botão de resposta rápida de um template (ex: "Quero saber mais").
                msg_body = message_obj.button?.text || "[Clicou em um botão]";
            } else if (msg_type === "interactive") {
                // Resposta a uma mensagem interativa (lista ou botões) enviada fora de template.
                const interactive = message_obj.interactive || {};
                if (interactive.type === "button_reply") {
                    msg_body = interactive.button_reply?.title || "[Clicou em um botão]";
                } else if (interactive.type === "list_reply") {
                    msg_body = interactive.list_reply?.title || "[Selecionou um item da lista]";
                } else {
                    msg_body = "[Resposta interativa]";
                }
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

                // Click-to-WhatsApp: id do clique do anúncio (atribuição da CAPI) + cópia enxuta do referral.
                const ctwaClid = message_obj.referral?.ctwa_clid || null;
                const adRefJson = message_obj.referral ? JSON.stringify({
                    ctwa_clid:   ctwaClid,
                    source_id:   message_obj.referral.source_id   || null,
                    source_type: message_obj.referral.source_type || null,
                    headline:    message_obj.referral.headline    || null
                }) : null;

                const quoted_id = message_obj.context ? message_obj.context.id : null;

                // 1. Salva a mensagem no histórico do chat (incluindo o campo referral e quoted_id)
                await queryD1(
                    'INSERT INTO wa_messages (id, phone, direction, message, status, referral, quoted_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [msg_id, from, 'in', msg_body, 'received', referral, quoted_id, msgTimestamp]
                );

                // 2. Verifica se o lead já existe no Kanban — casa qualquer forma equivalente
                //    do número (com/sem 55, com/sem o 9º dígito), não só substring.
                await ensureCapiColumns(); // ctwa_clid precisa existir pro SELECT/INSERT abaixo
                const variants = phoneVariants(from);
                const placeholders = variants.map(() => '?').join(', ');
                const leadRows = await queryD1(`SELECT id, nome, ctwa_clid FROM leads WHERE telefone IN (${placeholders})`, variants);

                // 3. Se não existe, cria um novo Lead no Kanban na coluna Novos (telefone sempre no formato canônico)
                let resolvedLeadId = null;
                if (!leadRows || leadRows.length === 0) {
                    const newLeadId = Date.now().toString();
                    resolvedLeadId = newLeadId;

                    let notasAdicionais = '';
                    if (message_obj.referral) {
                        notasAdicionais = `[Lead de Anúncio Meta]\nTítulo do Anúncio: ${message_obj.referral.headline || ''}\nDescrição: ${message_obj.referral.body || ''}\nLink: ${message_obj.referral.source_url || ''}\n\n`;
                    }

                    await ensureCapiColumns(); // garante ctwa_clid / ad_referral antes do INSERT
                    await queryD1(
                        'INSERT INTO leads (id, nome, telefone, origem, born, owner_id, column_id, fb_click_id, email, notas, ctwa_clid, ad_referral) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        [newLeadId, profileName, normalizePhoneBR(from), origemLead, '', '', 'col-entrada', '', '', notasAdicionais, ctwaClid, adRefJson]
                    );
                    console.log(`Novo lead criado a partir do WhatsApp: ${profileName} (${from}) - Origem: ${origemLead}`);

                    // Veio de anúncio (Click-to-WhatsApp)? Dispara o Lead agora — clique fresco, match forte.
                    if (ctwaClid) {
                        await fireCapiForLead(newLeadId, 'Lead').catch(e => console.error('CAPI Lead:', e.message));
                    }

                    // Notifica a equipe que um novo lead entrou no funil.
                    try {
                        const leadName = (profileName && profileName !== 'Lead WhatsApp') ? profileName : 'Lead WhatsApp';
                        const notifMsg = `🌱 Novo lead: ${leadName} — ${origemLead || 'WhatsApp'}`;
                        await queryD1(
                            'INSERT INTO crm_notifications (id, message, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
                            [`lead-${newLeadId}`, notifMsg]
                        );
                        sendPushToAll('Novo lead', notifMsg).catch(() => {});
                    } catch (e) {
                        console.error('Falha ao registrar notificação de novo lead:', e.message);
                    }
                } else {
                    resolvedLeadId = leadRows[0].id;
                    const existingLead = leadRows[0];
                    // Lead que volta clicando num anúncio: grava o ctwa_clid se ainda não tiver (first-touch).
                    if (ctwaClid && !existingLead.ctwa_clid) {
                        try {
                            await queryD1('UPDATE leads SET ctwa_clid = ?, ad_referral = ? WHERE id = ?', [ctwaClid, adRefJson, existingLead.id]);
                            console.log(`ctwa_clid gravado num lead existente (${from})`);
                        } catch (e) { console.error('Falha ao gravar ctwa_clid em lead existente:', e.message); }
                    }
                    if (profileName !== 'Lead WhatsApp') {
                        // O nome do perfil nem sempre vem na primeira mensagem (depende de privacidade/tipo de mensagem).
                        // Se o lead ainda está com o nome genérico e uma mensagem posterior trouxe o nome real, atualiza.
                        if (!existingLead.nome || existingLead.nome === 'Lead WhatsApp') {
                            await queryD1('UPDATE leads SET nome = ? WHERE id = ?', [profileName, existingLead.id]);
                            console.log(`Nome do lead atualizado a partir do WhatsApp: ${profileName} (${from})`);
                        }
                    }
                }

                // Follow-up automático: o lead respondeu -> registra a última mensagem
                // dele e interrompe qualquer sequência de lembretes em andamento.
                try {
                    if (resolvedLeadId) {
                        await queryD1("UPDATE leads SET last_msg_at = ?, last_msg_direction = 'in' WHERE id = ?", [msgTimestamp, resolvedLeadId]);
                        await queryD1("UPDATE crm_followup_runs SET status = 'respondido', updated_at = CURRENT_TIMESTAMP WHERE lead_id = ? AND status IN ('agendado','enviando')", [resolvedLeadId]);
                    }
                } catch (e) { console.error('follow-up: hook de inbound falhou:', e.message); }

                // Avisa os atendentes conectados NA HORA (mesmo canal SSE do Kanban).
                // Sem isso, quem não está com essa conversa aberta só via mensagem nova
                // dependendo de polling — e o polling é pausado de propósito quando a
                // aba fica em segundo plano (economia de cota do D1). A conexão SSE
                // continua viva mesmo com a aba oculta, então plugamos nela em vez de
                // esperar o agente de IA (que pode levar vários segundos pra responder).
                if (resolvedLeadId) {
                    // Manda o telefone + prévia + hora no evento pra o front atualizar
                    // a lista de conversas SEM refazer a consulta cara (só remendo local).
                    try {
                        broadcastLeadsUpdate('wa_message', resolvedLeadId, {
                            phone: from, preview: msg_body, msg_ts: msgTimestamp
                        });
                    } catch (e) {}
                }

                // Agente de IA de pré-qualificação — precisa de "await" aqui: na Vercel
                // (serverless), a função é congelada assim que a resposta HTTP é
                // enviada, então um "fire-and-forget" sem await nunca chegava a
                // terminar (a chamada ao Gemini era interrompida no meio). A Meta
                // tolera alguns segundos de resposta antes de reentregar a mensagem.
                if ((msg_type === 'text' || msg_type === 'audio' || msg_type === 'voice' || msg_type === 'image') && msg_body && resolvedLeadId) {
                    // Motor de fluxo roda ANTES da IA. Se um fluxo assumir a conversa,
                    // a IA não responde esse turno.
                    let handledByFlow = false;
                    try {
                        handledByFlow = await flowDispatchInbound(resolvedLeadId, from, msg_body);
                    } catch (e) {
                        console.error('Erro no motor de fluxo:', e);
                    }
                    if (!handledByFlow) {
                        await handleWhatsappAiAutoReply(resolvedLeadId, from, msg_id, msgTimestamp).catch(e => console.error('Erro no agente de IA:', e));
                    }
                }
            } catch(e) {
                console.error("Erro ao processar webhook no DB:", e);
            }
        }

        // Handle message status updates: sent → delivered → read
        const allChanges = body.entry?.[0]?.changes ?? [];
        for (const change of allChanges) {
            const statuses = change.value?.statuses;
            if (!statuses) continue;
            for (const s of statuses) {
                if (!['sent', 'delivered', 'read', 'failed'].includes(s.status)) continue;

                // A Meta manda o motivo real da falha em s.errors — sem registrar isso,
                // a mensagem só aparecia com um "!" vermelho e ninguém sabia o porquê
                // (janela de 24h fechada, formato de áudio recusado na entrega, número
                // inválido, etc.).
                let errorDetail = null;
                if (s.status === 'failed') {
                    const err = Array.isArray(s.errors) ? s.errors[0] : null;
                    errorDetail = err
                        ? `[${err.code || '?'}] ${err.title || ''}${err.message && err.message !== err.title ? ' — ' + err.message : ''}${err.error_data?.details ? ' (' + err.error_data.details + ')' : ''}`.trim()
                        : 'Falha na entrega (sem detalhes da Meta).';
                    console.error('WhatsApp: entrega FALHOU', {
                        id: s.id,
                        recipient: s.recipient_id,
                        detail: errorDetail
                    });
                }

                try {
                    if (errorDetail) {
                        await queryD1('UPDATE wa_messages SET status = ?, error_detail = ? WHERE id = ?', [s.status, errorDetail, s.id]);
                    } else {
                        await queryD1('UPDATE wa_messages SET status = ? WHERE id = ?', [s.status, s.id]);
                    }
                } catch(e) {
                    console.error('Erro ao atualizar status da mensagem:', e);
                }
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
            let settled = false;
            const finish = (fn) => (arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
            const cmd = ffmpeg(inputPath)
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
                .on('error', finish((err) => reject(new Error('ffmpeg falhou: ' + (err && err.message || err)))))
                .on('end', finish(resolve));
            // Trava de segurança: se o ffmpeg travar, mata o processo e rejeita —
            // sem isso a requisição fica pendurada e pode derrubar o servidor.
            const timer = setTimeout(() => {
                if (settled) return; settled = true;
                try { cmd.kill('SIGKILL'); } catch (e) {}
                reject(new Error('ffmpeg: timeout de 20s na conversão do áudio'));
            }, 20000);
            cmd.save(outputPath);
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
    const { to, isTemplate, templateName, languageCode, templateParams, quoted_id, isReaction, reactionEmoji } = req.body;
    // mutável: resolvida abaixo se vier uma referência [MEDIALIB:id] da Biblioteca de Mídia
    let message = req.body.message;
    // mutável: se a conversão pra voice note falhar, cai pra áudio comum
    let isVoiceRecording = req.body.isVoiceRecording;

    if (!to) {
        return res.status(400).json({ error: "Número de destino (to) é obrigatório." });
    }

    const phone_id = process.env.META_WA_PHONE_ID;
    const token = process.env.META_WA_ACCESS_TOKEN;

    if (!phone_id || !token) {
        return res.status(500).json({ error: "Credenciais do WhatsApp não configuradas no servidor." });
    }

    // Trava anti-duplicidade: a MESMA mensagem de texto pro mesmo número em poucos
    // segundos é quase sempre clique/Enter duplicado ou reenvio por lag. Bloqueia
    // com 409, a menos que o cliente reenvie de propósito com force:true.
    if (!isReaction && !isTemplate && typeof message === 'string' && message.trim()
        && !message.includes('[FILE:') && !message.includes('[MEDIALIB:') && !req.body.force) {
        try {
            const dv = phoneVariants(to);
            const recent = await queryD1(
                `SELECT id FROM wa_messages
                 WHERE direction = 'out' AND message = ? AND phone IN (${dv.map(() => '?').join(', ')})
                   AND timestamp >= datetime('now', '-15 seconds')
                 LIMIT 1`,
                [message, ...dv]
            );
            if (recent && recent[0]) {
                return res.status(409).json({ error: 'Mensagem idêntica enviada há poucos segundos.', duplicate: true });
            }
        } catch (e) { /* se a checagem falhar, não bloqueia o envio */ }
    }

    try {
        let result;

        // Referência à Biblioteca de Mídia: [MEDIALIB:<id>][CAPTION:...] → vira o
        // formato padrão [FILE:nome]\n data:mime;base64,... e segue o caminho normal.
        if (typeof message === 'string' && message.includes('[MEDIALIB:')) {
            const mlMatch = message.match(/\[MEDIALIB:([^\]]+)\]/);
            const capMatch = message.match(/\[CAPTION:(.*?)\]/s);
            if (mlMatch) {
                const mrows = await queryD1('SELECT nome, mime, data_base64, legenda_padrao FROM crm_media WHERE id = ?', [mlMatch[1]]);
                if (!mrows || !mrows[0]) return res.status(404).json({ error: 'Mídia da biblioteca não encontrada.' });
                const mr = mrows[0];
                const cap = capMatch ? capMatch[1] : (mr.legenda_padrao || '');
                message = `[FILE:${mr.nome || 'arquivo'}]\n${cap ? `[CAPTION:${cap}]\n` : ''}data:${mr.mime};base64,${mr.data_base64}`;
            }
        }

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
                    // Se a conversão falhar, NÃO derruba o envio: manda o áudio original
                    // como anexo comum (ainda toca, só não vira "voice note").
                    if (mediaType === "audio" && isVoiceRecording && mimeType !== 'audio/ogg') {
                        const sourceExt = (mimeType.split('/')[1] || 'webm').split(';')[0];
                        console.log(`Convertendo gravação de voz (${mimeType}) para OGG/Opus... (buffer original: ${buffer.length} bytes)`);
                        try {
                            buffer = await convertToOggOpus(buffer, sourceExt);
                            mimeType = 'audio/ogg';
                            fileName = 'audio.ogg';
                            console.log(`Conversão concluída: buffer OGG final tem ${buffer.length} bytes.`);
                        } catch (convErr) {
                            console.error('Conversão de voz falhou — enviando áudio original sem flag de voz:', convErr && convErr.message);
                            isVoiceRecording = false;
                            if (!fileName || !fileName.includes('.')) fileName = `audio.${sourceExt || 'webm'}`;
                        }
                    }

                    // A Meta valida o Content-Type do upload de mídia e recusa
                    // parâmetros de codec no mime (ex.: "audio/ogg; codecs=opus").
                    // O codec real vai no próprio arquivo — aqui fica só o tipo base.
                    const uploadMime = mimeType.split(';')[0].trim();

                    // Faz o upload para a Meta
                    console.log(`Fazendo upload de mídia (${mediaType}, ${uploadMime}) para a Meta...`);
                    mediaId = await uploadMediaToMeta(buffer, uploadMime, fileName || `file.${uploadMime.split('/')[1]}`);
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
                // Templates com variável no corpo exigem um array de parâmetros
                // correspondente — sem isso a Meta rejeita com o erro #132000 "Number of
                // parameters does not match the expected number". Aceita tanto string pura
                // (variável posicional, ex: "Olá {{1}}") quanto objeto { text, parameter_name }
                // (variável nomeada, ex: "Oi {{customer_name}}" — formato mais novo da Meta,
                // que exige "parameter_name" em vez de depender só da ordem).
                if (Array.isArray(templateParams) && templateParams.length > 0) {
                    data.template.components = [{
                        type: "body",
                        parameters: templateParams.map(p => {
                            const isObj = p && typeof p === 'object';
                            const param = { type: "text", text: String(isObj ? p.text : p) };
                            if (isObj && p.parameter_name) param.parameter_name = p.parameter_name;
                            return param;
                        })
                    }];
                }
                // O front manda "message: 'template'" só como placeholder. Pro balão
                // do chat, monta o texto real do template (com as variáveis já
                // preenchidas) em vez de só o nome. Se a busca do modelo falhar,
                // cai no fallback com o nome.
                try {
                    const tMeta = await getWhatsappTemplateMeta(templateName || 'hello_world');
                    db_message_body = renderTemplateForHistory(templateName || 'hello_world', tMeta, templateParams);
                } catch (e) {
                    db_message_body = `📋 Template enviado: *${templateName || 'hello_world'}*`;
                }
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

        const sendRes = await postMetaMessage(phone_id, token, data);
        const resultJson = sendRes.resultJson;
        if (!sendRes.ok) {
            // 131026 nas duas formas do 9º dígito = o número não é uma conta de
            // WhatsApp válida. Marca o lead pra alguém ir atrás do número certo.
            if (resultJson.error && resultJson.error.code === 131026) {
                try {
                    const cv = phoneVariants(to);
                    await queryD1(
                        `UPDATE leads SET tags = TRIM(COALESCE(tags,'') || ',numero-invalido', ',')
                         WHERE telefone IN (${cv.map(() => '?').join(', ')})
                           AND (tags IS NULL OR tags NOT LIKE '%numero-invalido%')`,
                        cv
                    );
                } catch (e) { console.error('Falha ao marcar lead com numero-invalido:', e.message); }
            }
            throw new Error(resultJson.error ? resultJson.error.message : "Erro desconhecido na Meta API");
        }

        result = resultJson;

        // Forma de número que a Meta realmente aceitou: o wa_id canônico que ela
        // devolve, ou (se houve retry do 9º dígito) a variante que passou. Tudo
        // daqui pra frente — INSERT no histórico, lookups de lead — usa essa.
        const finalTo = (resultJson.contacts && resultJson.contacts[0] && resultJson.contacts[0].wa_id) || sendRes.usedTo || to;
        if (finalTo !== to) await migrateChatPhone(to, finalTo);

        // Salvar no banco local wa_messages
        try {
            let msg_id = result.messages ? result.messages[0].id : Date.now().toString();
            const sentBy = (req.user && req.user.username) ? req.user.username : null;
            await queryD1(
                'INSERT INTO wa_messages (id, phone, direction, message, status, quoted_id, sent_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [msg_id, finalTo, 'out', db_message_body, 'sent', quoted_id || null, sentBy]
            );

            // Essa rota só é chamada pelo atendente logado no CRM (a IA manda mensagem
            // direto por sendWhatsappTextInternal, sem passar por aqui) — então qualquer
            // envio por aqui significa que um humano já entrou na conversa. Desliga o
            // agente de IA pra esse lead, pra ele não responder por cima do atendente.
            try {
                const variants = phoneVariants(finalTo);
                const placeholders = variants.map(() => '?').join(', ');

                // Histórico: se fazia 3+ dias sem NENHUMA mensagem (nem nossa, nem
                // dele), esse envio manual conta como "recontato" — precisa ler o
                // last_msg_at ANTES de sobrescrever com o desta mensagem.
                const RECONTATO_GAP_MS = 3 * 86400000;
                const leadsAntes = await queryD1(`SELECT id, last_msg_at FROM leads WHERE telefone IN (${placeholders})`, variants);
                const actorEnvio = (req.user && req.user.username) || null;
                for (const l of (leadsAntes || [])) {
                    if (!l.last_msg_at) continue;
                    const prevDate = followupParseTs(l.last_msg_at);
                    const gapMs = prevDate ? Date.now() - prevDate.getTime() : 0;
                    if (gapMs >= RECONTATO_GAP_MS) {
                        logLeadEvent(l.id, 'recontato', actorEnvio, `${Math.floor(gapMs / 86400000)} dias de silêncio`);
                    }
                }

                await queryD1(`UPDATE leads SET ai_enabled = 0, last_msg_at = CURRENT_TIMESTAMP, last_msg_direction = 'out' WHERE telefone IN (${placeholders})`, variants);
                // Envio manual do atendente também interrompe follow-up automático em andamento.
                await queryD1(`UPDATE crm_followup_runs SET status = 'parado', updated_at = CURRENT_TIMESTAMP WHERE status IN ('agendado','enviando') AND phone IN (${placeholders})`, variants);

                // Atendente respondeu manualmente: se o lead estava marcado como "quente"
                // (badge de leads qualificados esperando), isso conta como atendido —
                // tira a etiqueta e o carimbo de horário pra sumir do badge.
                const quentes = await queryD1(`SELECT id, tags FROM leads WHERE telefone IN (${placeholders}) AND qualificado_em IS NOT NULL`, variants);
                for (const q of (quentes || [])) {
                    const restTags = (q.tags || '').split(',').map(t => t.trim()).filter(t => t && t !== 'ia-qualificado').join(',');
                    await queryD1('UPDATE leads SET tags = ?, qualificado_em = NULL WHERE id = ?', [restTags, q.id]);
                }
            } catch (e) {
                console.error('Erro ao desligar a IA após envio manual:', e);
            }

            // Registra o envio de template pra permitir bloquear reenvio do mesmo
            // template pro mesmo número em campanhas futuras.
            if (isTemplate && templateName) {
                await queryD1(
                    'INSERT INTO wa_template_sends (phone, template_name) VALUES (?, ?)',
                    [finalTo, templateName]
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

// ==========================================
// AGENTE DE IA — pré-qualificação automática de leads no WhatsApp
// ==========================================
// Envio de texto simples reaproveitável pela rota HTTP e pela IA, sem duplicar
// a lógica de mídia/template/reação de /api/whatsapp/send (que continua sendo
// o único caminho pra esses casos, usados só pelo atendente humano no CRM).
async function sendWhatsappTextInternal(to, text, sentBy = 'ia') {
    const phone_id = process.env.META_WA_PHONE_ID;
    const token = process.env.META_WA_ACCESS_TOKEN;
    if (!phone_id || !token) throw new Error('Credenciais do WhatsApp não configuradas no servidor.');

    const sendRes = await postMetaMessage(phone_id, token, { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } });
    const resultJson = sendRes.resultJson;
    if (!sendRes.ok) throw new Error(resultJson.error ? resultJson.error.message : 'Erro desconhecido na Meta API');
    const finalTo = (resultJson.contacts && resultJson.contacts[0] && resultJson.contacts[0].wa_id) || sendRes.usedTo || to;
    if (finalTo !== to) await migrateChatPhone(to, finalTo);

    const msg_id = resultJson.messages ? resultJson.messages[0].id : Date.now().toString();
    await queryD1(
        'INSERT INTO wa_messages (id, phone, direction, message, status, sent_by) VALUES (?, ?, ?, ?, ?, ?)',
        [msg_id, finalTo, 'out', text, 'sent', sentBy]
    );
    try {
        const v = phoneVariants(finalTo);
        await queryD1(`UPDATE leads SET last_msg_at = CURRENT_TIMESTAMP, last_msg_direction = 'out' WHERE telefone IN (${v.map(() => '?').join(', ')})`, v);
    } catch (e) {}
    return resultJson;
}

// Cache curto dos metadados de template da Meta (nome -> idioma / nº de variáveis
// no corpo). Evita bater na Graph API a cada tick do follow-up; TTL de 5 min é
// suficiente porque template aprovado quase nunca muda.
const _waTemplateMetaCache = new Map();
async function getWhatsappTemplateMeta(name) {
    const key = String(name || '').trim();
    if (!key) throw new Error('Nome do template vazio.');
    const cached = _waTemplateMetaCache.get(key);
    if (cached && (Date.now() - cached.at) < 5 * 60 * 1000) return cached.meta;

    const wabaId = process.env.META_WABA_ID;
    const token = process.env.META_WA_ACCESS_TOKEN;
    if (!wabaId || !token) throw new Error('META_WABA_ID / token do WhatsApp não configurados no servidor.');

    const url = `https://graph.facebook.com/v20.0/${wabaId}/message_templates?name=${encodeURIComponent(key)}&fields=name,status,category,language,components&limit=20`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const json = await resp.json();
    if (!resp.ok) throw new Error(json.error?.message || 'Erro ao buscar template na Meta.');

    // O mesmo nome pode existir em vários idiomas — prioriza um aprovado em pt.
    const rows = (json.data || []).filter(t => t.name === key);
    const row = rows.find(t => t.status === 'APPROVED' && /^pt/i.test(t.language || ''))
        || rows.find(t => t.status === 'APPROVED')
        || rows[0];
    if (!row) throw new Error(`Template "${key}" não encontrado na Meta.`);
    if (row.status !== 'APPROVED') throw new Error(`Template "${key}" não está aprovado (status ${row.status}).`);

    const bodyComp = (row.components || []).find(c => c.type === 'BODY');
    const headerComp = (row.components || []).find(c => c.type === 'HEADER');
    const footerComp = (row.components || []).find(c => c.type === 'FOOTER');
    const varMatches = ((bodyComp && bodyComp.text) || '').match(/\{\{\s*[\w\d_]+\s*\}\}/g) || [];
    const bodyVarName = varMatches[0] ? varMatches[0].replace(/[{}\s]/g, '') : null;
    const meta = {
        language: row.language || 'pt_BR',
        category: row.category || null,
        bodyVarCount: varMatches.length,
        bodyVarName,
        isNamedParam: !!bodyVarName && !/^\d+$/.test(bodyVarName),
        bodyText: (bodyComp && bodyComp.text) || '',
        headerText: (headerComp && String(headerComp.format || 'TEXT').toUpperCase() === 'TEXT') ? (headerComp.text || '') : '',
        headerFormat: headerComp ? String(headerComp.format || 'TEXT').toUpperCase() : null,
        footerText: (footerComp && footerComp.text) || '',
    };
    _waTemplateMetaCache.set(key, { at: Date.now(), meta });
    return meta;
}

// Monta o texto legível de um template (com as variáveis preenchidas) pra salvar
// no histórico do chat — assim o balão mostra a mensagem de verdade, não só o
// nome do template.
function renderTemplateForHistory(templateName, meta, templateParams) {
    const params = Array.isArray(templateParams) ? templateParams : [];
    const fill = (txt) => String(txt || '').replace(/\{\{\s*([\w\d_]+)\s*\}\}/g, (m, key) => {
        // {{1}} -> posicional; {{nome}} -> casa pelo parameter_name, senão cai no 1º
        let p;
        if (/^\d+$/.test(key)) p = params[parseInt(key, 10) - 1];
        else p = params.find(x => x && typeof x === 'object' && x.parameter_name === key) || params[0];
        const val = p && typeof p === 'object' ? p.text : p;
        return (val != null && val !== '') ? val : m;
    });
    const parts = [];
    if (meta && meta.headerFormat && meta.headerFormat !== 'TEXT') parts.push(`[${meta.headerFormat.toLowerCase()}]`);
    else if (meta && meta.headerText) parts.push(fill(meta.headerText));
    if (meta && meta.bodyText) parts.push(fill(meta.bodyText));
    if (meta && meta.footerText) parts.push(meta.footerText);
    const corpo = parts.join('\n\n').trim();
    return corpo ? `📋 _Template: ${templateName}_\n${corpo}` : `📋 Template enviado: *${templateName}*`;
}

// Envia um template aprovado da Meta por um caminho interno (follow-up, fluxos) —
// mesmo payload de /api/whatsapp/send, sem a parte de mídia/reação. Preenche no
// máximo UMA variável de corpo, com opts.nome (mesma convenção do disparo em
// massa). Template com 2+ variáveis não é suportado por aqui.
async function sendWhatsappTemplateInternal(to, templateName, opts = {}) {
    const phone_id = process.env.META_WA_PHONE_ID;
    const token = process.env.META_WA_ACCESS_TOKEN;
    if (!phone_id || !token) throw new Error('Credenciais do WhatsApp não configuradas no servidor.');

    const name = String(templateName || '').trim();
    const meta = await getWhatsappTemplateMeta(name);
    if (meta.bodyVarCount > 1) {
        throw new Error(`Template "${name}" tem ${meta.bodyVarCount} variáveis no corpo; o follow-up só suporta 0 ou 1.`);
    }

    const data = {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: { name, language: { code: meta.language || 'pt_BR' } },
    };
    let bodyParams = null;
    if (meta.bodyVarCount === 1) {
        const param = { type: 'text', text: String(opts.nome || 'Cliente') };
        if (meta.isNamedParam) param.parameter_name = meta.bodyVarName;
        bodyParams = [param];
        data.template.components = [{ type: 'body', parameters: bodyParams }];
    }

    const sendRes = await postMetaMessage(phone_id, token, data);
    const resultJson = sendRes.resultJson;
    if (!sendRes.ok) throw new Error(resultJson.error ? resultJson.error.message : 'Erro desconhecido na Meta API');
    const finalTo = (resultJson.contacts && resultJson.contacts[0] && resultJson.contacts[0].wa_id) || sendRes.usedTo || to;
    if (finalTo !== to) await migrateChatPhone(to, finalTo);

    const msg_id = resultJson.messages ? resultJson.messages[0].id : Date.now().toString();
    await queryD1(
        'INSERT INTO wa_messages (id, phone, direction, message, status, sent_by) VALUES (?, ?, ?, ?, ?, ?)',
        [msg_id, finalTo, 'out', renderTemplateForHistory(name, meta, bodyParams), 'sent', opts.sentBy || 'followup']
    );
    try {
        const v = phoneVariants(finalTo);
        await queryD1(`UPDATE leads SET last_msg_at = CURRENT_TIMESTAMP, last_msg_direction = 'out' WHERE telefone IN (${v.map(() => '?').join(', ')})`, v);
    } catch (e) {}
    try {
        await queryD1('INSERT INTO wa_template_sends (phone, template_name) VALUES (?, ?)', [finalTo, name]);
    } catch (e) {}
    return resultJson;
}

// Envia um áudio (buffer OGG/Opus) como mensagem de voz nativa. O media_id da
// Meta expira, então quem chama passa o buffer pronto (ex.: crm_voice_library).
async function sendWhatsappAudioInternal(to, buffer, fileName = 'audio.ogg', sentBy = 'fluxo') {
    const phone_id = process.env.META_WA_PHONE_ID;
    const token = process.env.META_WA_ACCESS_TOKEN;
    if (!phone_id || !token) throw new Error('Credenciais do WhatsApp não configuradas no servidor.');

    const mediaId = await uploadMediaToMeta(buffer, 'audio/ogg', fileName);
    const sendRes = await postMetaMessage(phone_id, token, { messaging_product: 'whatsapp', to, type: 'audio', audio: { id: mediaId, voice: true } });
    const resultJson = sendRes.resultJson;
    if (!sendRes.ok) throw new Error(resultJson.error ? resultJson.error.message : 'Erro desconhecido na Meta API');
    const finalTo = (resultJson.contacts && resultJson.contacts[0] && resultJson.contacts[0].wa_id) || sendRes.usedTo || to;
    if (finalTo !== to) await migrateChatPhone(to, finalTo);

    const msg_id = resultJson.messages ? resultJson.messages[0].id : Date.now().toString();
    await queryD1(
        'INSERT INTO wa_messages (id, phone, direction, message, status, sent_by) VALUES (?, ?, ?, ?, ?, ?)',
        [msg_id, finalTo, 'out', `[FILE:${fileName}]/api/whatsapp/media/${mediaId}.ogg`, 'sent', sentBy]
    );
    try {
        const v = phoneVariants(finalTo);
        await queryD1(`UPDATE leads SET last_msg_at = CURRENT_TIMESTAMP, last_msg_direction = 'out' WHERE telefone IN (${v.map(() => '?').join(', ')})`, v);
    } catch (e) {}
    return resultJson;
}

// Prompt fixo com a identidade e as regras da Natuclinic. Nunca revela ser IA
// e nunca fala de preço — perguntar valor é justamente um dos gatilhos pra
// considerar o lead qualificado e silenciar (token QUALIFICADO_SILENCIO).
// Parte editável (pela tela "Contexto da IA" no CRM, admin-only) — identidade,
// unidades, horário, serviços, tom. Esse texto abaixo é só o valor PADRÃO,
// usado enquanto ninguém salvar uma versão customizada em crm_settings
// (chave 'whatsapp_ai_context').
const WHATSAPP_AI_DEFAULT_CONTEXT = `Você é uma atendente da Natuclinic, uma clínica de estética e saúde da mulher em Brasília (DF). Você conversa pelo WhatsApp com pacientes/leads que entraram em contato.

UNIDADES:
- Taguatinga Norte: QNE 1 Lote 17/20 Loja 02.
- Planaltina-DF: Cond. Estância 1, Módulo C/E, Lt 1, em frente à SkyFit.

HORÁRIO: Segunda a sexta, 8h às 18h. Sábado, 8h às 12h.

SERVIÇOS OFERECIDOS:
- Depilação a laser
- Ozonioterapia
- Nutrição Ortomolecular
- Estética Regenerativa
- Estética Facial - Harmonização e Preenchimento
- Preenchimento de Glúteos
- Remoção de Vasinhos (não varizes)
- SPA (banheira hidromassagem, degustação, massagem corporal completa, até 2 pessoas)
- Médica especialista em saúde da mulher
- Ninfoescultura
- Tratamento de incontinência em mulheres
- Fortalecimento pélvico
- Perfiloplastia
- Soroterapia
- Harmonização Corporal - Harmone Bee
- Reset (Rejuvenescimento e reestruturação facial)
- Bag de Ozônio
- Reabilitação Intestinal - Enematerapia com ozônio

REGRAS DE TOM:
- Tom consultivo e humano. Frases curtas e objetivas.
- Nunca, em nenhuma hipótese, diga que é uma inteligência artificial, robô, assistente virtual ou sistema automatizado. Converse como uma pessoa da equipe.
- Sempre termine sua resposta com uma pergunta aberta, pra entender melhor a necessidade do paciente (o que ele busca, há quanto tempo, o que já tentou, etc.).
- Não invente informações que não estão aqui (preços, disponibilidade de agenda, promoções). Se perguntarem algo que você não sabe, direcione pra um atendente.`;

// Partes FIXAS de comportamento, nunca editáveis pela tela — é o que faz o
// mecanismo de handoff funcionar (token de silêncio). Uma delas é sempre anexada
// ao contexto conforme o MODO do agente, pra ninguém quebrar o handoff sem
// querer ao editar o texto do contexto.
const WHATSAPP_AI_QUALIFIED_TOKEN = 'QUALIFICADO_SILENCIO';

// Modo "qualificação" (padrão): entende a necessidade e passa rápido pro humano.
const WHATSAPP_AI_SILENCE_RULE = `

REGRA CRÍTICA DE SILÊNCIO:
Você NUNCA fala sobre valores/preços. Se o paciente perguntar quanto custa qualquer coisa, OU se em algum momento você julgar que já entendeu o suficiente da necessidade dele para um atendente humano assumir a conversa e fechar o procedimento, sua resposta deve ser EXATAMENTE a palavra:
QUALIFICADO_SILENCIO
(sem mais nada — nem pontuação, nem explicação). Isso sinaliza ao sistema que a IA deve parar de responder aquele contato.`;

// Modo "vendas": conduz a conversa até o paciente aceitar agendar uma avaliação,
// tratando objeções — mas continua sem inventar preço e com o mesmo token de
// handoff, que agora dispara mais pra frente (na hora de fechar).
const WHATSAPP_AI_SALES_RULE = `

REGRA DE MODO — VENDAS:
Seu papel é NÃO parar de conversar. Você conduz o paciente, passo a passo, até ele ACEITAR AGENDAR UMA AVALIAÇÃO presencial. Enquanto isso não acontecer, você SEMPRE responde — nunca devolve o controle.

Como conduzir:
- Faça descoberta: entenda o objetivo, há quanto tempo, o que já tentou, o impacto no dia a dia. Uma pergunta por vez.
- Depois da descoberta, apresente o procedimento com profundidade usando o contexto acima: como funciona, benefícios, o que esperar, cuidados. NÃO invente dados.
- Trate objeções com empatia ("vou pensar", medo, falta de tempo, "depois eu vejo"): acolha, reforce segurança e resultados, e volte a propor a avaliação.
- Termine a RESPOSTA (não cada frase) com um próximo passo: convide para agendar a avaliação e ofereça duas opções ("prefere de manhã ou à tarde?", "essa semana ou a próxima?"). UMA vez só, no fim.
- NUNCA invente preço, promoção ou horário disponível. Se perguntarem valor: explique que depende da avaliação, que lá a pessoa recebe o plano e o valor certos, e proponha agendar.
- Nunca diga que é uma IA/robô/sistema.

NÃO FAÇA HANDOFF (não responda o token) quando o paciente só:
- respondeu uma pergunta de descoberta (ex.: "faz uns meses", "é pra disposição", "já tentei vitamina");
- demonstrou interesse ou fez uma pergunta sobre o procedimento;
- levantou uma objeção. Nesses casos, CONTINUE a conversa você mesmo.

QUANDO PARAR (handoff): só então responda EXATAMENTE a palavra QUALIFICADO_SILENCIO (sozinha, sem pontuação):
- o paciente concordou em agendar, ou informou um dia/horário;
- pediu explicitamente para falar com uma pessoa da equipe;
- insistiu num valor exato mesmo depois de você já ter explicado;
- perguntou sobre um agendamento que já existe, remarcação, ou fez uma dúvida médica específica.
Fora desses casos, você NUNCA responde o token.`;

// Sempre anexada (qualquer modo). Corrige o vício de mandar 5-6 balões
// repetindo a mesma ideia e a mesma pergunta.
const WHATSAPP_AI_FORMAT_RULE = `

FORMATO DA RESPOSTA (OBRIGATÓRIO):
- No MÁXIMO 2 mensagens curtas, separadas por UMA linha em branco. Cada mensagem com 1 ou 2 frases.
- NUNCA repita a mesma informação nem a mesma pergunta na mesma resposta.
- No máximo UMA pergunta na resposta inteira, sempre na última mensagem.
- Escreva como no WhatsApp: direto, sem "Prezado(a)", sem listas, sem títulos.`;

async function getWhatsappAiContext() {
    try {
        const rows = await queryD1("SELECT value FROM crm_settings WHERE key = 'whatsapp_ai_context'");
        return (rows && rows[0] && rows[0].value) ? rows[0].value : WHATSAPP_AI_DEFAULT_CONTEXT;
    } catch (e) {
        return WHATSAPP_AI_DEFAULT_CONTEXT;
    }
}

// Modo do agente: 'vendas' ou 'qualificacao' (padrão).
async function getWhatsappAiMode() {
    try {
        const rows = await queryD1("SELECT value FROM crm_settings WHERE key = 'whatsapp_ai_mode'");
        return (rows && rows[0] && rows[0].value === 'vendas') ? 'vendas' : 'qualificacao';
    } catch (e) {
        return 'qualificacao';
    }
}

// Busca o histórico recente da conversa (as duas direções) e monta o formato
// "contents" que a API do Gemini espera, pra IA responder com contexto.
// Agente "vê" imagem? (whatsapp_ai_vision, liga por padrão)
async function getWhatsappAiVision() {
    try {
        const rows = await queryD1("SELECT value FROM crm_settings WHERE key = 'whatsapp_ai_vision'");
        return !(rows && rows[0] && rows[0].value === '0');
    } catch (e) { return true; }
}

// Agente "escuta" áudio/nota de voz? (whatsapp_ai_audio, liga por padrão)
async function getWhatsappAiAudio() {
    try {
        const rows = await queryD1("SELECT value FROM crm_settings WHERE key = 'whatsapp_ai_audio'");
        return !(rows && rows[0] && rows[0].value === '0');
    } catch (e) { return true; }
}

const AI_MAX_IMAGES = 2;                       // quantas imagens recentes o agente enxerga
const AI_MAX_AUDIOS = 1;                       // só a nota de voz mais recente — custa mais token
const AI_IMG_MAX_BYTES = 5 * 1024 * 1024;

// Baixa uma mídia da Meta e devolve { mimeType, data(base64) } — ou null.
async function fetchMetaMediaBase64(mediaId, fallbackMime = 'image/jpeg') {
    const token = process.env.META_WA_ACCESS_TOKEN;
    if (!token || !mediaId) return null;
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 6000);
    try {
        const info = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
            headers: { Authorization: `Bearer ${token}` }, signal: ac.signal
        }).then(r => (r.ok ? r.json() : null));
        if (!info || !info.url) return null;
        if (info.file_size && info.file_size > AI_IMG_MAX_BYTES) return null;
        const bin = await fetch(info.url, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal });
        if (!bin.ok) return null;
        const buf = Buffer.from(await bin.arrayBuffer());
        if (buf.length > AI_IMG_MAX_BYTES) return null;
        // Meta às vezes manda "audio/ogg; codecs=opus" — o Gemini só aceita o tipo puro.
        const mimeType = (info.mime_type || fallbackMime).split(';')[0].trim();
        return { mimeType, data: buf.toString('base64') };
    } catch (e) {
        return null;
    } finally {
        clearTimeout(to);
    }
}

async function getWhatsappAiHistory(phone, limit = 12) {
    const rows = await queryD1(
        'SELECT direction, message FROM wa_messages WHERE phone = ? ORDER BY timestamp DESC LIMIT ?',
        [phone, limit]
    );
    const ordered = (rows || []).reverse();

    // Imagens recebidas mais recentes que o agente vai "ver" (base64 inline na chamada).
    const imgRe = /\/api\/whatsapp\/media\/(\d+)\.(jpe?g|png|webp)/i;
    const imgCache = {};
    if (await getWhatsappAiVision()) {
        const idxs = [];
        for (let i = ordered.length - 1; i >= 0 && idxs.length < AI_MAX_IMAGES; i--) {
            const r = ordered[i];
            if (r.direction === 'in' && typeof r.message === 'string' && imgRe.test(r.message)) idxs.push(i);
        }
        await Promise.all(idxs.map(async (i) => {
            const m = ordered[i].message.match(imgRe);
            if (m) imgCache[i] = await fetchMetaMediaBase64(m[1], 'image/jpeg');
        }));
    }

    // Nota de voz mais recente que o agente vai "escutar" (mesmo esquema da imagem).
    const audioRe = /\/api\/whatsapp\/media\/(\d+)\.(ogg|oga|opus|mp3|m4a|amr)/i;
    const audioCache = {};
    if (await getWhatsappAiAudio()) {
        const idxs = [];
        for (let i = ordered.length - 1; i >= 0 && idxs.length < AI_MAX_AUDIOS; i--) {
            const r = ordered[i];
            if (r.direction === 'in' && typeof r.message === 'string' && audioRe.test(r.message)) idxs.push(i);
        }
        await Promise.all(idxs.map(async (i) => {
            const m = ordered[i].message.match(audioRe);
            if (m) audioCache[i] = await fetchMetaMediaBase64(m[1], 'audio/ogg');
        }));
    }

    return ordered.map((r, i) => {
        const role = r.direction === 'in' ? 'user' : 'model';
        const raw = r.message || '';
        if (raw.startsWith('[FILE:')) {
            const cap = (raw.match(/\[CAPTION:(.*?)\]/s) || [])[1] || '';
            const img = imgCache[i];
            if (img) {
                return { role, parts: [
                    { inlineData: { mimeType: img.mimeType, data: img.data } },
                    { text: cap ? `(imagem que o paciente enviou) ${cap}` : '(imagem que o paciente enviou)' }
                ] };
            }
            const audio = audioCache[i];
            if (audio) {
                return { role, parts: [
                    { inlineData: { mimeType: audio.mimeType, data: audio.data } },
                    { text: '(nota de voz que o paciente enviou — ouça e responda ao que ela disse)' }
                ] };
            }
            return { role, parts: [{ text: cap ? `[mídia enviada] ${cap}` : '[mídia enviada]' }] };
        }
        return { role, parts: [{ text: raw }] };
    });
}

// Contexto do anúncio de Click-to-WhatsApp que o lead clicou. O agente não
// enxergava isso — via só "Posso ter mais informações sobre isso?" sem saber o
// que era "isso" — e chutava o procedimento errado (anúncio de depilação a
// laser, resposta oferecendo HiPRO). Pega o referral da 1ª mensagem com anúncio.
async function getAdContextForPhone(phone) {
    try {
        const rows = await queryD1(
            "SELECT referral FROM wa_messages WHERE phone = ? AND referral IS NOT NULL AND referral != '' ORDER BY timestamp ASC LIMIT 1",
            [phone]
        );
        const raw = rows && rows[0] && rows[0].referral;
        if (!raw) return '';
        let ref; try { ref = JSON.parse(raw); } catch (e) { return ''; }
        const headline = String(ref.headline || '').trim();
        let body = String(ref.body || '').trim();
        // Se o anúncio foi identificado (source_id) e o criativo completo já foi
        // sincronizado pela Marketing API, usa ele — é mais completo que o trecho
        // que o webhook do WhatsApp entrega.
        if (ref.source_id) {
            try {
                const adRows = await queryD1('SELECT creative_body FROM ad_ads WHERE id = ?', [String(ref.source_id)]);
                const full = adRows && adRows[0] && String(adRows[0].creative_body || '').trim();
                if (full) body = full;
            } catch (e) { /* ad_ads pode não existir se o sync nunca rodou */ }
        }
        if (!headline && !body) return '';
        let t = '\n\n[ORIGEM DO LEAD] Esta pessoa chegou clicando num anúncio de Instagram/Facebook da clínica. Baseie a conversa NO QUE ESSE ANÚNCIO PROMETIA — não ofereça um procedimento diferente do anúncio.';
        if (headline) t += `\nTítulo do anúncio: "${headline}"`;
        if (body) t += `\nTexto do anúncio: "${body.slice(0, 600)}"`;
        return t;
    } catch (e) { return ''; }
}

async function callGeminiForWhatsappReply(phone) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY não configurada no .env.');

    const history = await getWhatsappAiHistory(phone);
    const context = await getWhatsappAiContext();
    const adContext = await getAdContextForPhone(phone);
    const mode = await getWhatsappAiMode();
    const behaviorRule = mode === 'vendas' ? WHATSAPP_AI_SALES_RULE : WHATSAPP_AI_SILENCE_RULE;
    const systemPrompt = context + adContext + behaviorRule + WHATSAPP_AI_FORMAT_RULE;
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-goog-api-key': apiKey },
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: history
        })
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error ? json.error.message : 'Erro desconhecido na API do Gemini');

    const text = json.candidates?.[0]?.content?.parts?.map(p => p.text).join('').trim() || '';
    return normalizeAiReply(text);
}

// Às vezes o modelo devolve ["msg 1", "msg 2"] (ou dentro de ```json ... ```)
// quando quer mandar mensagens separadas. Sem isso, a string crua "[\"...\"]"
// era enviada literalmente pro paciente. Converte pra texto com parágrafos
// duplos — que o sendWhatsappAiReplyHuman já quebra em mensagens.
function normalizeAiReply(raw) {
    let s = String(raw || '').trim();
    const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fence) s = fence[1].trim();
    if ((s.startsWith('[') && s.endsWith(']')) || (s.startsWith('{') && s.endsWith('}'))) {
        try {
            const v = JSON.parse(s);
            if (Array.isArray(v)) {
                return v.map(x => String(x).trim()).filter(Boolean).join('\n\n');
            }
            if (v && typeof v === 'object') {
                const arr = v.messages || v.mensagens || v.reply || v.resposta;
                if (Array.isArray(arr)) return arr.map(x => String(x).trim()).filter(Boolean).join('\n\n');
                if (typeof arr === 'string') return arr.trim();
            }
        } catch (e) { /* não era JSON de verdade, segue com o texto cru */ }
    }
    return s;
}

// ============================================================================
// COPILOT DE IA — assistente interno pros atendentes (Gemini). É PASSIVO: só lê
// o histórico da conversa e devolve texto pro painel do atendente. NUNCA envia
// mensagem sozinho e não encosta no fluxo do agente automático (webhook).
// ============================================================================
const COPILOT_MODEL = 'gemini-3.6-flash';
const copilotLastCall = new Map(); // username -> timestamp (anti-spam simples)

function copilotRedact(text) {
    return String(text || '')
        .replace(/\[FILE:[^\]]*\]\S*/g, '(mídia)')
        .replace(/\d[\d\s().-]{7,}\d/g, '[número]');
}

async function copilotTranscript(phone, limit = 20) {
    const rows = await queryD1(
        'SELECT direction, message FROM wa_messages WHERE phone = ? ORDER BY timestamp DESC LIMIT ?',
        [phone, limit]
    );
    return (rows || []).reverse()
        .map(r => `${r.direction === 'in' ? 'Paciente' : 'Atendimento'}: ${copilotRedact(r.message)}`)
        .join('\n');
}

async function callGeminiCopilot(systemPrompt, userText) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY não configurada no servidor.');
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${COPILOT_MODEL}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-goog-api-key': apiKey },
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userText }] }],
            // maxOutputTokens generoso: mesmo que o modelo gaste parte "pensando"
            // (é modelo thinking), sobra espaço pra resposta visível não sair
            // cortada. thinkingConfig foi removido — o modelo recusava com
            // INVALID_ARGUMENT.
            generationConfig: {
                temperature: 0.6,
                maxOutputTokens: 2048
            }
        })
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error ? json.error.message : 'Erro na API do Gemini');
    const candidate = json.candidates?.[0];
    const text = (candidate?.content?.parts?.map(p => p.text).join('') || '').trim();
    if (!text && candidate?.finishReason && candidate.finishReason !== 'STOP') {
        throw new Error(`Gemini interrompeu a resposta (${candidate.finishReason})`);
    }
    return normalizeAiReply(text);
}

// true = pode seguir; false = já respondeu 429.
function copilotThrottle(req, res) {
    const user = (req.user && req.user.username) || 'anon';
    const now = Date.now();
    if (now - (copilotLastCall.get(user) || 0) < 2500) {
        res.status(429).json({ error: 'Aguarde um instante antes de pedir de novo.' });
        return false;
    }
    copilotLastCall.set(user, now);
    return true;
}

app.post('/api/copilot/summarize', async (req, res) => {
    try {
        const phone = String(req.body.phone || '').replace(/\D/g, '');
        if (!phone) return res.status(400).json({ error: 'Telefone não informado.' });
        if (!copilotThrottle(req, res)) return;
        const transcript = await copilotTranscript(phone, 24);
        if (!transcript) return res.json({ summary: 'Ainda não há mensagens nessa conversa.' });
        const contexto = await getWhatsappAiContext();
        const sys = `${contexto}

Você é um assistente interno de CRM de uma clínica. NÃO fala com o paciente — só ajuda o atendente humano. A partir do histórico abaixo, escreva um briefing curto (no máximo 3 linhas, em português) dizendo: o que o paciente quer, em que ponto a conversa está, e qual a pendência / próximo passo do atendente. Sem saudação, sem despedida, direto ao ponto.`;
        const summary = await callGeminiCopilot(sys, `Histórico:\n${transcript}`);
        res.json({ summary: summary || 'Não consegui resumir.' });
    } catch (e) {
        console.error('copilot/summarize:', e.message);
        res.status(502).json({ error: e.message || 'Falha ao gerar o resumo.' });
    }
});

app.post('/api/copilot/draft-reply', async (req, res) => {
    try {
        const phone = String(req.body.phone || '').replace(/\D/g, '');
        const instruction = String(req.body.instruction || '').trim();
        if (!phone) return res.status(400).json({ error: 'Telefone não informado.' });
        if (!instruction) return res.status(400).json({ error: 'Diga o que você quer responder.' });
        if (!copilotThrottle(req, res)) return;
        const transcript = await copilotTranscript(phone, 16);
        const contexto = await getWhatsappAiContext();
        const sys = `${contexto}

Você é um assistente que redige mensagens de WhatsApp para o ATENDENTE humano de uma clínica enviar ao paciente. Escreva UMA mensagem pronta, em português, tom acolhedor e profissional, curta e natural (como no WhatsApp). NÃO invente preço, horário ou informação que não esteja no pedido do atendente ou no histórico. Não repita saudação se a conversa já está em andamento. Responda só com o texto da mensagem, nada mais.`;
        const text = await callGeminiCopilot(
            sys,
            `Conversa até aqui:\n${transcript || '(sem histórico)'}\n\nO atendente quer dizer: "${instruction}"\n\nEscreva a mensagem:`
        );
        res.json({ text: text || '' });
    } catch (e) {
        console.error('copilot/draft-reply:', e.message);
        res.status(502).json({ error: e.message || 'Falha ao gerar a resposta.' });
    }
});

// Chamado (sem await, "fire-and-forget") pelo webhook quando uma mensagem de
// texto chega de um lead elegível (IA ligada, coluna inicial do funil).
// Mesmas etiquetas padrão do frontend (wa_chat_logic.js DEFAULT_TAGS) — usadas
// só como semente caso ninguém tenha criado nenhuma etiqueta ainda, pra
// garantir a tag "Qualificado (IA)" sem apagar as etiquetas padrão de todo
// mundo (whatsapp_custom_tags, se vazia, vira só a lista que a gente salvar).
const WHATSAPP_DEFAULT_TAGS_SEED = [
    { id: 'urgente', label: '🔥 Urgente', bg: 'rgba(239, 68, 68, 0.15)', color: '#f87171', border: '#ef4444' },
    { id: 'vip', label: '⭐ VIP', bg: 'rgba(245, 158, 11, 0.15)', color: '#fbbf24', border: '#f59e0b' },
    { id: 'aguardando', label: '⏳ Aguardando Resposta', bg: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa', border: '#3b82f6' },
    { id: 'interessado', label: '💉 Interesse em Procedimento', bg: 'rgba(45, 212, 191, 0.15)', color: '#5eead4', border: '#2dd4bf' },
    { id: 'orcamento', label: '📄 Orçamento Enviado', bg: 'rgba(16, 185, 129, 0.15)', color: '#34d399', border: '#10b981' },
    { id: 'retorno', label: '🔄 Retorno', bg: 'rgba(249, 115, 22, 0.15)', color: '#fb923c', border: '#f97316' }
];
const WHATSAPP_AI_QUALIFIED_TAG_ID = 'ia-qualificado';

// Garante que a etiqueta "Qualificado (IA)" existe na lista compartilhada de
// etiquetas (crm_settings.whatsapp_custom_tags), criando-a (e semeando as
// padrão, se a lista ainda estiver vazia) na primeira vez que for necessária.
async function ensureQualifiedTagExists() {
    const rows = await queryD1("SELECT value FROM crm_settings WHERE key = 'whatsapp_custom_tags'");
    let tags = [];
    if (rows && rows[0] && rows[0].value) {
        try { tags = JSON.parse(rows[0].value); } catch (e) {}
    }
    if (!Array.isArray(tags) || tags.length === 0) {
        tags = [...WHATSAPP_DEFAULT_TAGS_SEED];
    }
    if (!tags.some(t => t.id === WHATSAPP_AI_QUALIFIED_TAG_ID)) {
        tags.push({ id: WHATSAPP_AI_QUALIFIED_TAG_ID, label: '🎯 Qualificado (IA)', bg: 'rgba(16, 185, 129, 0.15)', color: '#34d399', border: '#10b981' });
        await queryD1(
            "INSERT INTO crm_settings (key, value) VALUES ('whatsapp_custom_tags', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [JSON.stringify(tags)]
        );
    }
    return WHATSAPP_AI_QUALIFIED_TAG_ID;
}

const DISCARDED_TAG_ID = 'descartado';

// Garante que a etiqueta "Descartado" existe na lista compartilhada — sem
// isso, getTagBadgeHTML() no front não acha o id e o badge simplesmente não
// aparece (mesmo bug que já existia pras outras tags automáticas antes de
// ganharem seu próprio ensure*TagExists).
async function ensureDiscardedTagExists() {
    const rows = await queryD1("SELECT value FROM crm_settings WHERE key = 'whatsapp_custom_tags'");
    let tags = [];
    if (rows && rows[0] && rows[0].value) {
        try { tags = JSON.parse(rows[0].value); } catch (e) {}
    }
    if (!Array.isArray(tags) || tags.length === 0) {
        tags = [...WHATSAPP_DEFAULT_TAGS_SEED];
    }
    if (!tags.some(t => t.id === DISCARDED_TAG_ID)) {
        tags.push({ id: DISCARDED_TAG_ID, label: '🚫 Descartado', bg: 'rgba(148, 163, 184, 0.15)', color: '#94a3b8', border: '#64748b' });
        await queryD1(
            "INSERT INTO crm_settings (key, value) VALUES ('whatsapp_custom_tags', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [JSON.stringify(tags)]
        );
    }
    return DISCARDED_TAG_ID;
}

// Acrescenta a tag "Qualificado (IA)" ao lead sem duplicar e sem apagar as
// etiquetas que ele já tinha.
async function tagLeadAsQualified(leadId) {
    const tagId = await ensureQualifiedTagExists();
    const rows = await queryD1('SELECT tags FROM leads WHERE id = ?', [leadId]);
    const currentTags = (rows?.[0]?.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    if (currentTags.includes(tagId)) return;
    currentTags.push(tagId);
    await queryD1('UPDATE leads SET tags = ?, qualificado_em = CURRENT_TIMESTAMP WHERE id = ?', [currentTags.join(','), leadId]);
}

// ---- Ritmo humano do agente de IA -----------------------------------------
// Defaults; cada chave pode ser sobrescrita em crm_settings (whatsapp_ai_<k>).
const AI_TIMING_DEFAULTS = {
    read_min: 2, read_max: 6,     // pausa de "leitura" antes da 1ª mensagem (s)
    cps: 15,                      // caracteres por segundo "digitados"
    type_min: 1.2, type_max: 7,   // piso / teto do tempo por mensagem (s)
    jitter: 0.35,                // variação aleatória ± em cada espera
    distracted_pct: 0.08,        // chance de uma pausa longa extra (3–8 s)
    max_total: 11                // teto da soma das pausas (s) — anti-timeout
};
async function getWhatsappAiTiming() {
    const keys = [...Object.keys(AI_TIMING_DEFAULTS).map(k => 'whatsapp_ai_' + k), 'whatsapp_ai_human', 'whatsapp_ai_typing'];
    const map = {};
    try {
        const rows = await queryD1(`SELECT key, value FROM crm_settings WHERE key IN (${keys.map(() => '?').join(',')})`, keys);
        (rows || []).forEach(r => { map[r.key] = r.value; });
    } catch (e) {}
    const num = (k) => {
        const v = parseFloat(map['whatsapp_ai_' + k]);
        return Number.isFinite(v) && v >= 0 ? v : AI_TIMING_DEFAULTS[k];
    };
    return {
        human:  map.whatsapp_ai_human  !== '0',   // liga por padrão
        typing: map.whatsapp_ai_typing !== '0',   // liga por padrão
        readMinMs: num('read_min') * 1000,
        readMaxMs: num('read_max') * 1000,
        cps: Math.max(4, num('cps')),
        typeMinMs: num('type_min') * 1000,
        typeMaxMs: num('type_max') * 1000,
        jitter: Math.min(0.9, num('jitter')),
        distractedPct: Math.min(0.5, num('distracted_pct')),
        maxTotalMs: num('max_total') * 1000
    };
}

// "digitando…" (e marca a mensagem recebida como lida). Dura ~25 s ou até a
// próxima mensagem — reenviar antes de cada pausa.
async function sendTypingIndicator(incomingWamid) {
    const phone_id = process.env.META_WA_PHONE_ID, token = process.env.META_WA_ACCESS_TOKEN;
    if (!phone_id || !token || !incomingWamid) return;
    try {
        await fetch(`https://graph.facebook.com/v20.0/${phone_id}/messages`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messaging_product: 'whatsapp', status: 'read',
                message_id: incomingWamid, typing_indicator: { type: 'text' }
            })
        });
    } catch (e) {}
}

// IA ainda ligada nesse lead? (atendente pode ter assumido no meio do ritmo)
async function aiStillOnForPhone(phone) {
    try {
        const v = phoneVariants(phone);
        const rows = await queryD1(`SELECT ai_enabled FROM leads WHERE telefone IN (${v.map(() => '?').join(',')}) LIMIT 1`, v);
        return !!(rows && rows[0] && Number(rows[0].ai_enabled) === 1);
    } catch (e) { return true; } // na dúvida, não corta
}

// Envia a resposta da IA. Cada parágrafo (linha em branco) vira uma mensagem.
// Com ritmo humano ligado: pausa de leitura variável, tempo de digitação
// proporcional ao tamanho, jitter, distração ocasional e "digitando…".
// supersededCheck (opcional): callback assíncrono que devolve true se outra
// invocação já deve responder no lugar dessa (rajada de mensagens do lead —
// veja o comentário grande acima de handleWhatsappAiAutoReply). Reaproveita as
// pausas de ritmo humano que já existem aqui como janela de "assentamento" da
// rajada, em vez de somar mais um atraso novo (a soma já é limitada por
// max_total pra não estourar o timeout do webhook da Meta).
async function sendWhatsappAiReplyHuman(phone, replyText, incomingWamid, floorSec = 0, supersededCheck = null) {
    let parts = String(replyText || '').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
    if (!parts.length) return;
    // Trava dura: nunca mais que 3 balões por resposta (o modelo às vezes cospe
    // 5-6). O excedente é juntado na última mensagem.
    const AI_MAX_CHUNKS = 3;
    if (parts.length > AI_MAX_CHUNKS) {
        parts = [...parts.slice(0, AI_MAX_CHUNKS - 1), parts.slice(AI_MAX_CHUNKS - 1).join('\n\n')];
    }

    const stillGood = async () => {
        if (!(await aiStillOnForPhone(phone))) return false;
        if (supersededCheck && await supersededCheck()) return false;
        return true;
    };

    const cfg = await getWhatsappAiTiming();

    // Ritmo humano desligado: comportamento antigo (delay fixo + gap uniforme).
    if (!cfg.human) {
        if (floorSec > 0) {
            await new Promise(r => setTimeout(r, floorSec * 1000));
            if (!(await stillGood())) return;
        }
        for (let i = 0; i < parts.length; i++) {
            if (!(await stillGood())) return;
            await sendWhatsappTextInternal(phone, parts[i]);
            if (i < parts.length - 1) await new Promise(r => setTimeout(r, 700 + Math.floor(Math.random() * 500)));
        }
        return;
    }

    const rand = (a, b) => a + Math.random() * (b - a);
    const jit  = (ms) => Math.round(ms * (1 + (Math.random() * 2 - 1) * cfg.jitter));
    let budget = Math.max(cfg.maxTotalMs, floorSec * 1000);
    const sleep = (ms) => {
        ms = Math.max(0, Math.min(Math.round(ms), budget));
        budget -= ms;
        return new Promise(r => setTimeout(r, ms));
    };

    // pausa de leitura — nunca abaixo do "Tempo de resposta" configurado
    let readMs = Math.max(jit(rand(cfg.readMinMs, cfg.readMaxMs)), floorSec * 1000);
    if (cfg.typing) await sendTypingIndicator(incomingWamid);
    await sleep(readMs);
    if (!(await stillGood())) return;

    for (let i = 0; i < parts.length; i++) {
        if (!(await stillGood())) return;

        let wait = jit(Math.min(Math.max((parts[i].length / cfg.cps) * 1000, cfg.typeMinMs), cfg.typeMaxMs));
        if (i > 0 && Math.random() < cfg.distractedPct) wait += rand(3000, 8000);

        if (cfg.typing) await sendTypingIndicator(incomingWamid);
        await sleep(wait);
        await sendWhatsappTextInternal(phone, parts[i]);
    }
}

// Anti-duplicidade da IA: quando o lead manda uma rajada de mensagens, a Meta
// dispara um webhook por mensagem, e cada um chama handleWhatsappAiAutoReply em
// paralelo — sem trava, cada invocação gera e envia sua própria resposta (saíam
// 2-3 respostas completas, cada uma quase igual, parafraseando a mesma coisa —
// ex.: duas saudações "Oi, sou a Nati..." seguidas). A defesa é "coalescer": só
// responde a invocação cuja mensagem-gatilho (incomingWamid) ainda for a ÚLTIMA
// mensagem recebida do lead; as demais abortam e deixam essa responder já com a
// conversa toda no contexto. Decidido pelo estado em wa_messages, então vale
// igual em invocações concorrentes (servidor local) ou separadas (serverless).
// Sem atraso novo: reaproveita a latência que já existe (chamada ao Gemini +
// pausas de ritmo humano) como janela de assentamento, checando em cada ponto.

async function latestInboundMsgId(phone) {
    const rows = await queryD1(
        "SELECT id FROM wa_messages WHERE phone = ? AND direction = 'in' ORDER BY timestamp DESC, rowid DESC LIMIT 1",
        [phone]
    );
    return rows && rows[0] ? rows[0].id : null;
}

// Exclui sent_by='ia': senão, o 1º balão que a própria IA acabou de mandar
// (sendWhatsappAiReplyHuman manda um por um) já conta como "alguém respondeu
// depois do gatilho" e cancela os balões seguintes da MESMA resposta — só
// mandava o primeiro pedaço de toda resposta partida em várias mensagens.
// Continua pegando atendente humano ou fluxo assumindo no meio (sent_by
// diferente de 'ia'), que é o caso real que essa checagem devia cobrir.
async function hasOutboundSince(phone, sinceTs) {
    if (!sinceTs) return false;
    const rows = await queryD1(
        "SELECT 1 FROM wa_messages WHERE phone = ? AND direction = 'out' AND timestamp >= ? AND (sent_by IS NULL OR sent_by != 'ia') LIMIT 1",
        [phone, sinceTs]
    );
    return !!(rows && rows[0]);
}

// true = essa invocação deve desistir (chegou mensagem nova do lead depois do
// gatilho, ou alguém já respondeu depois dele).
async function aiReplySupersededBy(phone, incomingWamid, triggerTs) {
    if (incomingWamid) {
        const latest = await latestInboundMsgId(phone);
        if (latest && latest !== incomingWamid) return true;
    }
    if (await hasOutboundSince(phone, triggerTs)) return true;
    return false;
}

async function handleWhatsappAiAutoReply(leadId, phone, incomingWamid, triggerTs = null) {
    try {
        const globalSetting = await queryD1("SELECT value FROM crm_settings WHERE key = 'whatsapp_ai_enabled'");
        const globalEnabled = globalSetting && globalSetting[0] ? globalSetting[0].value === '1' : true;
        if (!globalEnabled) return;

        const leadRows = await queryD1('SELECT ai_enabled, column_id FROM leads WHERE id = ?', [leadId]);
        const lead = leadRows && leadRows[0];
        if (!lead || Number(lead.ai_enabled) !== 1) return;
        if (!['col-entrada', 'col-contatado'].includes(lead.column_id)) return;

        // Checagem de entrada: se por acaso essa invocação só rodou depois que
        // uma mensagem mais nova do lead já chegou (fila do event loop, retry da
        // Meta etc.), desiste na hora — a invocação da mensagem mais nova cuida.
        if (await aiReplySupersededBy(phone, incomingWamid, triggerTs)) return;

        const replyText = await callGeminiForWhatsappReply(phone);
        if (!replyText) return;

        // A chamada ao Gemini acima já deu tempo de uma mensagem-irmã da mesma
        // rajada chegar e ser processada — reconfere antes de decidir o que fazer
        // com a resposta.
        if (await aiReplySupersededBy(phone, incomingWamid, triggerTs)) return;

        if (replyText.startsWith(WHATSAPP_AI_QUALIFIED_TOKEN)) {
            const aiMode = await getWhatsappAiMode();
            await queryD1('UPDATE leads SET ai_enabled = 0 WHERE id = ?', [leadId]);
            await tagLeadAsQualified(leadId);
            const notas = await queryD1('SELECT notas FROM leads WHERE id = ?', [leadId]);
            const notaAtual = notas?.[0]?.notas || '';
            const motivo = aiMode === 'vendas'
                ? 'IA de vendas conduziu a conversa — lead pronto pra fechar/agendar'
                : 'IA identificou lead qualificado';
            const novaNota = `${notaAtual}${notaAtual ? '\n' : ''}🤖 ${motivo} em ${new Date().toLocaleString('pt-BR')} — assumir conversa.`;
            await queryD1('UPDATE leads SET notas = ? WHERE id = ?', [novaNota, leadId]);
            logLeadEvent(leadId, 'lead_qualificado_ia', 'ia', motivo);
            const infoRows = await queryD1('SELECT nome, telefone FROM leads WHERE id = ?', [leadId]);
            const nomeBruto = (infoRows?.[0]?.nome || '').replace(' [MKT]', '').trim();
            const nomeLead = (nomeBruto && !LEAD_NOME_PLACEHOLDER_RE.test(nomeBruto)) ? nomeBruto : 'Lead';
            const telLead = infoRows?.[0]?.telefone || phone || null;
            const notifMsg = aiMode === 'vendas'
                ? `🎯 ${nomeLead} — pronto pra fechar, assumir a conversa`
                : `🎯 ${nomeLead} está qualificada — pronta pra atender`;
            const notifId = `ai-qual-${leadId}-${Date.now()}`;
            try {
                await queryD1(
                    'INSERT INTO crm_notifications (id, message, created_at, action_phone) VALUES (?, ?, CURRENT_TIMESTAMP, ?)',
                    [notifId, notifMsg, telLead]
                );
            } catch (e) {
                // Coluna action_phone pode não existir ainda — grava sem ela.
                await queryD1(
                    'INSERT INTO crm_notifications (id, message, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
                    [notifId, notifMsg]
                ).catch(() => {});
            }
            sendPushToAll('Lead quente 🔥', notifMsg, { phone: telLead }).catch(() => {});
            return;
        }

        // Ritmo humano: pausa de leitura variável, tempo de digitação proporcional
        // ao texto, jitter, "digitando…". O "Tempo de resposta" (whatsapp_ai_reply_delay)
        // vira o mínimo da pausa inicial. Aborta se a IA do lead for desligada no meio.
        // Não se aplica ao handoff de qualificação acima.
        const replyDelay = await getWhatsappAiReplyDelay();
        await sendWhatsappAiReplyHuman(phone, replyText, incomingWamid, replyDelay,
            () => aiReplySupersededBy(phone, incomingWamid, triggerTs));
    } catch (e) {
        console.error('Erro no agente de IA do WhatsApp:', e);
    }
}

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
// A lista de conversas é a consulta MAIS CARA do sistema: GROUP BY na
// wa_messages inteira + 3 subconsultas por conversa, sem filtro. Era ~65% de
// todo o rows_read diário do D1 porque o polling de cada aba a chamava ~1x/min.
// Agora: (1) snapshot cacheado numa linha do D1 com TTL de 5 min — vale entre as
// instâncias serverless da Vercel; (2) mensagem nova NÃO refaz a consulta — o
// front remenda a lista localmente com os dados que vêm no evento SSE
// 'wa_message'; (3) o polling caiu pra 90s, só como rede de segurança. Assim a
// consulta cara roda ~1x a cada 5 min em vez de ~1x/min.
const WA_CHATS_CACHE_TTL_MS = 5 * 60 * 1000;

async function buildWaChatsList() {
    // message/direction/status precisam vir da ÚLTIMA mensagem da conversa.
    // Não dá pra confiar no "bare column + MAX()" do SQLite aqui (o D1 não
    // garante que a coluna solta venha da linha do MAX) — por isso subquery
    // explícita ordenando por timestamp e, no empate de segundo, por rowid.
    return await queryD1(`
        SELECT m.phone,
               MAX(m.timestamp) as last_interaction,
               (SELECT x.message   FROM wa_messages x WHERE x.phone = m.phone ORDER BY x.timestamp DESC, x.rowid DESC LIMIT 1) as message,
               (SELECT x.direction FROM wa_messages x WHERE x.phone = m.phone ORDER BY x.timestamp DESC, x.rowid DESC LIMIT 1) as direction,
               (SELECT x.status    FROM wa_messages x WHERE x.phone = m.phone ORDER BY x.timestamp DESC, x.rowid DESC LIMIT 1) as status,
               SUM(CASE WHEN m.direction = 'in' AND (m.status IS NULL OR m.status != 'read') THEN 1 ELSE 0 END) as unread_count
        FROM wa_messages m
        GROUP BY m.phone
        ORDER BY last_interaction DESC
        LIMIT 500
    `);
}

async function getWaChatsList() {
    try {
        const row = await queryD1("SELECT value FROM crm_settings WHERE key = 'wa_chats_cache'");
        if (row && row[0] && row[0].value) {
            const cached = JSON.parse(row[0].value);
            if (cached && cached.built_at && Array.isArray(cached.rows) &&
                (Date.now() - cached.built_at) < WA_CHATS_CACHE_TTL_MS) {
                return cached.rows;
            }
        }
    } catch (e) {}
    const rows = await buildWaChatsList();
    try {
        await queryD1(
            "INSERT INTO crm_settings (key, value) VALUES ('wa_chats_cache', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [JSON.stringify({ built_at: Date.now(), rows: rows || [] })]
        );
    } catch (e) { /* blob grande demais ou erro de gravação: só não cacheia dessa vez */ }
    return rows || [];
}

// A lista de conversas é servida de um cache com TTL de 5 min. mark-read grava
// status='read' em wa_messages, mas sem remendar esse cache a bolinha de não
// lidas reaparecia num reload até o cache expirar. Aqui zeramos unread_count
// (e ajustamos o status da última mensagem) das linhas do(s) telefone(s), em vez
// de invalidar — invalidar forçaria a consulta cara na próxima leitura.
async function waChatsCacheMarkRead(phonesArr) {
    try {
        const row = await queryD1("SELECT value FROM crm_settings WHERE key = 'wa_chats_cache'");
        if (!row || !row[0] || !row[0].value) return;
        const cached = JSON.parse(row[0].value);
        if (!cached || !Array.isArray(cached.rows)) return;
        const alvo = new Set(phonesArr.map(p => String(p).replace(/\D/g, '')));
        let mudou = false;
        for (const c of cached.rows) {
            if (!alvo.has(String(c.phone || '').replace(/\D/g, ''))) continue;
            if (Number(c.unread_count || 0) !== 0) { c.unread_count = 0; mudou = true; }
            if (c.direction === 'in' && c.status !== 'read') { c.status = 'read'; mudou = true; }
        }
        if (mudou) {
            await queryD1(
                "INSERT INTO crm_settings (key, value) VALUES ('wa_chats_cache', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [JSON.stringify(cached)]
            );
        }
    } catch (e) { /* cache é best-effort */ }
}

app.get('/api/whatsapp/chats', async (req, res) => {
    try {
        const rows = await getWaChatsList();
        res.json({ success: true, data: rows });
    } catch(e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// Base de contatos: todo número que já trocou mensagem no WhatsApp, com a data do
// primeiro e do último contato e o volume de mensagens. O cruzamento com a ficha
// do lead (nome, origem, etapa no funil) é feito no cliente, que já mantém o
// array de leads carregado.
app.get('/api/contacts', async (req, res) => {
    try {
        const rows = await queryD1(`
            SELECT phone,
                   MIN(timestamp) as first_contact,
                   MAX(timestamp) as last_contact,
                   COUNT(*) as total_messages,
                   SUM(CASE WHEN direction = 'in'  THEN 1 ELSE 0 END) as inbound_count,
                   SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) as outbound_count
            FROM wa_messages
            WHERE phone IS NOT NULL AND phone != ''
            GROUP BY phone
            ORDER BY first_contact DESC
        `);
        res.json({ success: true, data: rows || [] });
    } catch (e) {
        console.error('Erro ao listar contatos:', e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// Métricas de resposta por conversa, usadas pelo dashboard.
app.get('/api/whatsapp/response-metrics', async (req, res) => {
    try {
        const rows = await queryD1(`
            SELECT phone, direction, timestamp
            FROM wa_messages
            ORDER BY phone ASC, timestamp ASC
        `);
        const metrics = {};

        for (const row of rows || []) {
            const phone = row.phone;
            if (!phone) continue;
            if (!metrics[phone]) metrics[phone] = { firstInbound: null, firstResponse: null, lastDirection: null };
            const metric = metrics[phone];
            metric.lastDirection = row.direction;
            if (row.direction === 'in' && !metric.firstInbound) {
                metric.firstInbound = row.timestamp;
            } else if (row.direction === 'out' && metric.firstInbound && !metric.firstResponse) {
                metric.firstResponse = row.timestamp;
            }
        }

        res.json({ success: true, data: metrics });
    } catch (e) {
        console.error('Erro ao calcular métricas de resposta:', e);
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

const CHAT_SETTINGS_FIELDS = ['is_favorite', 'is_pinned', 'is_archived', 'marked_unread', 'is_blocked'];

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
        // A tabela real (D1) usa id/shortcut/title/content — não shortcut/text como esse
        // endpoint tentava gravar antes, o que sempre falhava com erro de coluna/NOT NULL.
        // original_shortcut identifica a linha ao editar (permite renomear o atalho).
        const { shortcut, title, text, original_shortcut } = req.body;
        if (!shortcut || !text) return res.status(400).json({ error: "shortcut e text são obrigatórios" });

        const lookupShortcut = original_shortcut || shortcut;
        const existing = await queryD1('SELECT id FROM wa_quick_replies WHERE shortcut = ?', [lookupShortcut]);
        if (existing && existing.length > 0) {
            await queryD1('UPDATE wa_quick_replies SET shortcut = ?, title = ?, content = ? WHERE id = ?', [shortcut, title || '', text, existing[0].id]);
        } else {
            const id = `qr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            await queryD1('INSERT INTO wa_quick_replies (id, shortcut, title, content) VALUES (?, ?, ?, ?)', [id, shortcut, title || '', text]);
        }
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
        await waChatsCacheMarkRead(phonesArr);
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
    const headers = { 'Authorization': `Bearer ${AMIGO_API_TOKEN}` };

    try {
        // Busca os agendamentos e, em paralelo, a lista de profissionais — assim a
        // grade já monta todas as colunas mesmo nos dias em que alguém não tem
        // nenhum agendamento (antes elas sumiam).
        const [response, docsRes] = await Promise.all([
            fetch(url, { method: 'GET', headers }),
            fetch('https://amigobot-api.amigoapp.com.br/doctors', { headers }).catch(() => null)
        ]);

        let realData = [];
        try { realData = await response.json(); } catch(e) {}

        if (!response.ok) {
            throw new Error(realData.message || 'Erro ao consultar Amigo App');
        }

        let doctors = [];
        try {
            const dj = docsRes && docsRes.ok ? await docsRes.json() : null;
            doctors = (dj && (dj.data || dj)) || [];
            if (!Array.isArray(doctors)) doctors = [];
            doctors = doctors.map(d => ({ id: d.id, name: d.name })).filter(d => d.id != null);
        } catch (e) {}

        res.status(200).json({ data: realData.data || realData, doctors });
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
// Motivo da falha de entrega (preenchido pelo webhook de status da Meta)
queryD1("ALTER TABLE wa_messages ADD COLUMN error_detail TEXT").catch(() => {});
// Quem enviou a mensagem de saída: username do atendente, 'ia' pra resposta automática, NULL pra legado
queryD1("ALTER TABLE wa_messages ADD COLUMN sent_by TEXT").catch(() => {});
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
// Telefone do lead pra clicar na notificação e abrir a conversa (handoff da IA).
queryD1("ALTER TABLE crm_notifications ADD COLUMN action_phone TEXT").catch(() => {});
queryD1("ALTER TABLE crm_chat_settings ADD COLUMN is_blocked INTEGER DEFAULT 0").catch(() => {});

// Presença em conversa: quem está com a conversa de um lead ABERTA agora (só
// visual — mostra o avatar do atendente no card do chat). Independente da trava
// de atendimento (owner_id): aqui pode ter mais de uma pessoa e não reatribui
// o lead. Uma linha por (lead, atendente); some sozinha quando o ping vence.
queryD1(`CREATE TABLE IF NOT EXISTS crm_chat_presence (
    lead_id TEXT NOT NULL,
    username TEXT NOT NULL,
    entered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_ping_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (lead_id, username)
)`).catch(() => {});

// Fluxo de atendimento (nodes): definição do grafo + estado de execução por lead.
queryD1(`CREATE TABLE IF NOT EXISTS crm_flows (
    id TEXT PRIMARY KEY,
    nome TEXT,
    ativo INTEGER DEFAULT 0,
    prioridade INTEGER DEFAULT 0,
    graph_json TEXT,
    version INTEGER DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});
queryD1(`CREATE TABLE IF NOT EXISTS crm_flow_runs (
    id TEXT PRIMARY KEY,
    flow_id TEXT,
    flow_version INTEGER,
    lead_id TEXT,
    phone TEXT,
    status TEXT,
    current_node_id TEXT,
    context_json TEXT,
    next_wake_at DATETIME,
    steps_done INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});

// Follow-up automático: cadência global fica em crm_settings ('followup_config');
// aqui só o estado de execução por lead. last_msg_* aceleram o "quem está aguardando".
queryD1(`CREATE TABLE IF NOT EXISTS crm_followup_runs (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    phone TEXT,
    origem TEXT,
    step_idx INTEGER DEFAULT 0,
    status TEXT,
    anchor_out_ts DATETIME,
    last_inbound_ts DATETIME,
    next_send_at DATETIME,
    attempts INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});
queryD1("ALTER TABLE leads ADD COLUMN last_msg_at DATETIME").catch(() => {});
queryD1("ALTER TABLE leads ADD COLUMN last_msg_direction TEXT").catch(() => {});

// Web Push: inscrições de notificação nativa (Windows/Android) por dispositivo
// logado. Uma linha por par (usuário, navegador/dispositivo) — a mesma pessoa
// pode ter várias (celular + PC).
// Histórico estruturado do lead (quem iniciou/finalizou atendimento, abriu
// orçamento, mudou de etapa, recontatou, etc.) — separado de "notas", que
// continua sendo só o texto livre que o atendente digita de propósito.
queryD1(`CREATE TABLE IF NOT EXISTS crm_lead_events (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    tipo TEXT NOT NULL,
    actor TEXT,
    detalhe TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});
queryD1("CREATE INDEX IF NOT EXISTS idx_lead_events_lead ON crm_lead_events(lead_id, created_at)").catch(() => {});

// Registra um evento no histórico do lead. Nunca lança — histórico é
// observabilidade, não pode derrubar a ação principal que o gerou.
async function logLeadEvent(leadId, tipo, actor, detalhe) {
    try {
        const id = 'ev-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        await queryD1(
            'INSERT INTO crm_lead_events (id, lead_id, tipo, actor, detalhe) VALUES (?, ?, ?, ?, ?)',
            [id, leadId, tipo, actor || null, detalhe || null]
        );
    } catch (e) {
        console.error('logLeadEvent falhou:', e.message);
    }
}

queryD1(`CREATE TABLE IF NOT EXISTS crm_push_subscriptions (
    id TEXT PRIMARY KEY,
    username TEXT,
    endpoint TEXT UNIQUE,
    p256dh TEXT,
    auth TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});

const VAPID_PUBLIC = (process.env.VAPID_PUBLIC_KEY || '').trim();
const VAPID_PRIVATE = (process.env.VAPID_PRIVATE_KEY || '').trim();
const VAPID_SUBJECT = (process.env.VAPID_SUBJECT || 'mailto:contato@example.com').trim();
const pushEnabled = !!(VAPID_PUBLIC && VAPID_PRIVATE);
if (pushEnabled) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
} else {
    console.warn('[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY não configuradas — Web Push desligado.');
}

// Manda uma notificação nativa (Windows/Android/etc.) pra TODOS os
// dispositivos inscritos. Nunca lança — falha em silêncio (a notificação
// dentro do app, via crm_notifications, já cobre o essencial). Inscrições
// mortas (endpoint expirado/revogado) são removidas automaticamente.
async function sendPushToAll(title, body, extra = {}) {
    if (!pushEnabled) return;
    try {
        const subs = await queryD1('SELECT id, endpoint, p256dh, auth FROM crm_push_subscriptions');
        if (!subs || !subs.length) return;
        const payload = JSON.stringify({ title, body, ...extra });
        await Promise.all(subs.map(async (s) => {
            try {
                await webpush.sendNotification(
                    { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
                    payload
                );
            } catch (e) {
                // 404/410 = inscrição morta (usuário desinstalou/limpou dados) — remove.
                if (e.statusCode === 404 || e.statusCode === 410) {
                    queryD1('DELETE FROM crm_push_subscriptions WHERE id = ?', [s.id]).catch(() => {});
                } else {
                    console.error('[push] falha ao enviar:', e.message);
                }
            }
        }));
    } catch (e) {
        console.error('[push] sendPushToAll falhou:', e.message);
    }
}

app.get('/api/push/vapid-public-key', (req, res) => res.json({ publicKey: VAPID_PUBLIC || null }));

app.post('/api/push/subscribe', async (req, res) => {
    try {
        const sub = req.body?.subscription;
        if (!sub || !sub.endpoint || !sub.keys) return res.status(400).json({ error: 'Inscrição inválida.' });
        const id = 'push-' + Buffer.from(sub.endpoint).toString('base64').slice(0, 40);
        await queryD1(
            `INSERT INTO crm_push_subscriptions (id, username, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(endpoint) DO UPDATE SET username = excluded.username, p256dh = excluded.p256dh, auth = excluded.auth`,
            [id, (req.user && req.user.username) || null, sub.endpoint, sub.keys.p256dh, sub.keys.auth]
        );
        res.json({ success: true });
    } catch (e) {
        console.error('push/subscribe:', e.message);
        res.status(500).json({ error: 'Erro interno.' });
    }
});

app.post('/api/push/unsubscribe', async (req, res) => {
    try {
        const endpoint = req.body?.endpoint;
        if (endpoint) await queryD1('DELETE FROM crm_push_subscriptions WHERE endpoint = ?', [endpoint]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Erro interno.' }); }
});

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

// Públicos salvos: recortes de leads (por responsável, origem e período de
// entrada) definidos no Kanban e reaproveitados no disparo de campanhas. Essa
// tabela só existia dentro da rota manual /api/init-db — como ninguém a
// chamou depois que a tabela foi adicionada ao código, ela nunca chegou a ser
// criada em produção, e todo GET /api/audiences batia em "no such table".
// Auto-criar aqui garante que ela exista sem depender de um passo manual.
queryD1(`CREATE TABLE IF NOT EXISTS lead_audiences (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT,
    origem TEXT,
    date_start TEXT,
    date_end TEXT,
    has_schedule INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});

// ==========================================
// ÍNDICES — sem eles, as rotas de polling (notificações a cada 60s, lista de
// chats, kanban) faziam full table scan a cada chamada e torravam a cota diária
// de rows_read do D1 (plano free = 5M/dia). Cada CREATE INDEX varre a tabela uma
// vez na primeira execução; depois é só manutenção incremental.
// crm_notifications: ORDER BY created_at DESC LIMIT 50 -> scan reverso do índice.
queryD1("CREATE INDEX IF NOT EXISTS idx_notif_created ON crm_notifications(created_at)").catch(() => {});
// wa_messages: GROUP BY phone + MAX(timestamp) da lista de conversas.
queryD1("CREATE INDEX IF NOT EXISTS idx_wa_msg_phone_ts ON wa_messages(phone, timestamp)").catch(() => {});
// wa_messages: UPDATE ... SET status='read' WHERE phone IN (...) AND direction='in'
// e a contagem de não lidas.
queryD1("CREATE INDEX IF NOT EXISTS idx_wa_msg_phone_status ON wa_messages(phone, direction, status)").catch(() => {});
// leads: SELECT * FROM leads ORDER BY created_at ASC (lista do kanban).
queryD1("CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at)").catch(() => {});
queryD1("CREATE INDEX IF NOT EXISTS idx_leads_owner_created ON leads(owner_id, created_at)").catch(() => {});
// crm_chat_presence: limpeza por last_ping_at vencido.
queryD1("CREATE INDEX IF NOT EXISTS idx_presence_ping ON crm_chat_presence(last_ping_at)").catch(() => {});
// leads: peneira de candidatos do detector de oportunidades ("lead mandou a
// última e está esperando"): WHERE last_msg_direction='in' AND last_msg_at BETWEEN ...
queryD1("CREATE INDEX IF NOT EXISTS idx_leads_lastmsg ON leads(last_msg_direction, last_msg_at)").catch(() => {});
// crm_followup_runs: SELECT ... WHERE lead_id = ? (checagens do followupTick e
// da ficha do lead) — sem isso lia ~42 linhas pra devolver 1.
queryD1("CREATE INDEX IF NOT EXISTS idx_followup_lead ON crm_followup_runs(lead_id, status)").catch(() => {});

// ==========================================
// DINHEIRO — sempre inteiro em centavos internamente
// ==========================================
// Aceita "R$ 1.234,56", "1.234,56", "1234.56", "1234", número ou vazio.
function brlToCents(input) {
    if (input === null || input === undefined) return null;
    if (typeof input === 'number') return isFinite(input) ? Math.round(input * 100) : null;
    let s = String(input).trim().replace(/R\$|\s| /gi, '');
    if (!s || s === '-') return null;
    if (s.includes(',')) {
        // formato pt-BR: ponto é separador de milhar, vírgula é decimal
        s = s.replace(/\./g, '').replace(',', '.');
    }
    const n = parseFloat(s);
    return isFinite(n) ? Math.round(n * 100) : null;
}

function centsToBRL(cents) {
    return ((Number(cents) || 0) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function todayISO() {
    return new Date().toISOString().split('T')[0];
}

// ==========================================
// FINANCEIRO — Recebimentos (ledger) e Contas a Receber
// ==========================================
// Cada linha é UM lançamento de recebimento (ou estorno). Substitui o campo
// único e mutável leads.valor_recebido: aqui cabem pagamento parcial, várias
// parcelas e estorno — cada um com data, forma e quem registrou. Valores SEMPRE
// em centavos (inteiro), pra soma nunca acumular erro de float.
queryD1(`CREATE TABLE IF NOT EXISTS crm_pagamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id TEXT,
    attendance_id TEXT,
    descricao TEXT,
    paciente TEXT,
    valor_centavos INTEGER NOT NULL,
    tipo TEXT NOT NULL DEFAULT 'recebimento',
    forma_pagamento TEXT,
    status TEXT NOT NULL DEFAULT 'pendente',
    vencimento TEXT,
    pago_em TEXT,
    parcela INTEGER DEFAULT 1,
    parcelas_total INTEGER DEFAULT 1,
    estorno_de INTEGER,
    criado_por TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});

// Migração: os valores de agendamentos_financeiro passam a ter espelho em
// centavos. As colunas TEXT antigas continuam (D1/SQLite não troca tipo de
// coluna); o código novo lê/escreve as *_centavos. Backfill idempotente abaixo.
queryD1("ALTER TABLE agendamentos_financeiro ADD COLUMN valor_primario_centavos INTEGER").catch(() => {});
queryD1("ALTER TABLE agendamentos_financeiro ADD COLUMN valor_secundario_centavos INTEGER").catch(() => {});

async function backfillAgendamentosCentavos() {
    try {
        const rows = await queryD1(
            "SELECT id, valor_primario, valor_secundario FROM agendamentos_financeiro WHERE valor_primario_centavos IS NULL OR valor_secundario_centavos IS NULL"
        );
        for (const r of rows) {
            await queryD1(
                "UPDATE agendamentos_financeiro SET valor_primario_centavos = ?, valor_secundario_centavos = ? WHERE id = ?",
                [brlToCents(r.valor_primario), brlToCents(r.valor_secundario), r.id]
            );
        }
        if (rows.length) console.log(`[financeiro] backfill de centavos: ${rows.length} agendamento(s) migrado(s).`);
    } catch (e) {
        console.warn('[financeiro] backfill de centavos falhou (repete no próximo boot):', e.message);
    }
}
backfillAgendamentosCentavos();

// Espelha o valor do card do Kanban em crm_pagamentos, pra esse dinheiro aparecer
// na tela Financeiro. Usa a soma do orçamento; sem orçamento, o valor_recebido.
// As linhas-espelho são marcadas com criado_por='kanban' + origem_sync='kanban'
// + lead_id, uma por parcela (parcela 1..N, N lido do orçamento).
// Idempotente: cria, atualiza valor/vencimento/status, ou remove se o card zerar.
const COLUNAS_COM_VALOR = ['col-orcado', 'col-agendado', 'col-ganho'];

// Trilha de auditoria: registra por que um espelho mudou. Só grava quando
// houve mudança de verdade (não em no-op). Ring trimado no backfill.
async function logSyncPag(leadId, gatilho, antes, depois) {
    try {
        await queryD1('INSERT INTO crm_sync_log (lead_id, gatilho, antes, depois) VALUES (?, ?, ?, ?)',
            [String(leadId), gatilho || 'auto', String(antes).slice(0, 400), String(depois).slice(0, 400)]);
    } catch (e) { /* trilha é best-effort */ }
}

function _pagDescricaoOrc(orcArr, fallbackNome) {
    const nomes = (orcArr || []).map(i => i && i.procedimento).filter(Boolean);
    if (!nomes.length) return 'Kanban: ' + (fallbackNome || 'venda');
    if (nomes.length === 1) return 'Kanban: ' + nomes[0];
    return 'Kanban: ' + nomes[0] + ' + ' + nomes[1] + (nomes.length > 2 ? ` (+${nomes.length - 2})` : '');
}

// Nº de parcelas lido dos campos de texto livre do orçamento (condicoes /
// formaPagamento / valor): "10x", "em 12 vezes", "6 parcelas". Sem indicação -> 1.
// Teto de 48 pra um erro de digitação não gerar um carnê gigante.
function _parcelasOrc(orcArr) {
    let n = 1;
    for (const it of orcArr || []) {
        const txt = [it && it.condicoes, it && it.formaPagamento, it && it.valor]
            .filter(Boolean).join(' ').toLowerCase();
        const m = txt.match(/(\d{1,2})\s*(?:x\b|vezes|parcelas?|parc\b)/);
        if (m) n = Math.max(n, parseInt(m[1], 10) || 1);
    }
    return Math.max(1, Math.min(48, n));
}

// Texto de forma de pagamento do orçamento -> enum de crm_pagamentos (best-effort).
function _formaOrcParaEnum(orcArr) {
    const txt = (orcArr || [])
        .map(i => [i && i.formaPagamento, i && i.condicoes].filter(Boolean).join(' '))
        .join(' ').toLowerCase();
    if (!txt.trim()) return null;
    if (/pix/.test(txt)) return 'pix';
    if (/boleto|carn[êe]/.test(txt)) return 'boleto';
    if (/d[ée]bito/.test(txt)) return 'cartao_debito';
    if (/cr[ée]dito|cart[ãa]o/.test(txt)) return 'cartao_credito';
    if (/transfer|ted\b|doc\b/.test(txt)) return 'transferencia';
    if (/dinheiro|esp[ée]cie|[àa]\s*vista/.test(txt)) return 'dinheiro';
    return null;
}

// Espelha o estado financeiro do card do Kanban em crm_pagamentos.
// Idempotente. Cobre criação, atualização de valor, parcelamento lido do
// orçamento ("Nx"), transição pendente<->pago nos dois sentidos, e remoção.
// Cada parcela é uma linha (origem_sync='kanban', parcela 1..N). Nunca lança —
// no pior caso o espelho fica desatualizado e a fila de retry reprocessa.
async function syncLeadPagamento(leadId, gatilho = 'auto') {
    try {
        // SELECT * de propósito: tolera colunas novas ainda não migradas
        // (janela de cold start) sem derrubar o sync inteiro.
        const rows = await queryD1('SELECT * FROM leads WHERE id = ?', [leadId]);
        if (!rows.length) return;
        const lead = rows[0];

        const orcArr = parseOrcamentoArray(lead.orcamento);
        const recCents = brlToCents(lead.valor_recebido) || 0;
        const orcCents = orcArr.reduce((s, it) => s + (brlToCents(it.valor) || 0), 0);
        // Total do cronograma: soma do orçamento manda; sem orçamento, o valor recebido.
        let cents = orcCents > 0 ? orcCents : recCents;
        const temValor = recCents > 0 || orcCents > 0;
        // Fora de coluna com valor e sem valor recebido -> não espelha.
        if (!recCents && !COLUNAS_COM_VALOR.includes(lead.column_id)) cents = 0;

        // Guarda contra erro de parsing (real x centavos): > R$ 1M num único lead
        // quase sempre é bug. Não escreve, registra.
        if (cents > 100000000) {
            console.warn(`[financeiro] valor suspeito no lead ${leadId}: ${cents} centavos — sync abortado`);
            await logSyncPag(leadId, gatilho, `${cents} centavos`, 'abortado:suspeito');
            return;
        }

        const mirrors = await queryD1(
            "SELECT * FROM crm_pagamentos WHERE lead_id = ? AND tipo = 'recebimento' AND origem_sync IN ('kanban','kanban-detached') ORDER BY parcela ASC, id ASC",
            [leadId]
        );
        // Financeiro assumiu o controle desse plano (reparcelou à mão): o card
        // não cria, não atualiza e não apaga nada.
        if (mirrors.some(m => m.origem_sync === 'kanban-detached')) return;

        // Indexa as linhas geridas por nº de parcela; dedup de corrida mantém a
        // mais nova (linha 'cancelado' = estorno manual, sempre preservada).
        const porParcela = new Map();
        for (const m of mirrors) {
            const k = Number(m.parcela) || 1;
            const prev = porParcela.get(k);
            if (!prev) { porParcela.set(k, m); continue; }
            const keep = prev.status === 'cancelado' ? prev
                : m.status === 'cancelado' ? m
                : (Number(m.id) > Number(prev.id) ? m : prev);
            const drop = keep === m ? prev : m;
            if (drop.status !== 'cancelado') await queryD1('DELETE FROM crm_pagamentos WHERE id = ?', [drop.id]);
            porParcela.set(k, keep);
        }

        if (!cents || cents <= 0) {
            let removidas = 0;
            for (const [, row] of porParcela) {
                if (row.status !== 'cancelado') { await queryD1('DELETE FROM crm_pagamentos WHERE id = ?', [row.id]); removidas++; }
            }
            if (removidas) await logSyncPag(leadId, gatilho, `${removidas} linha(s)`, 'removido');
            return;
        }

        const N = orcCents > 0 ? _parcelasOrc(orcArr) : 1;
        const descricao = _pagDescricaoOrc(orcArr, lead.nome);
        const forma = _formaOrcParaEnum(orcArr);
        // Quem montou o orçamento: created_by do item mais recente que tiver;
        // senão o atendente dono do lead. Vai pra crm_pagamentos.criado_por
        // (origem_sync='kanban' é o que marca a linha como espelho, não mais isso).
        const orcadoPor = orcArr.map(it => it && it.created_by).filter(Boolean).pop()
            || lead.owner_id || null;

        // Base do vencimento = data do orçamento (data_valor); fallback: hoje.
        // Parcela i vence data_valor + i meses (1..N) — 1ª parcela ~30 dias depois.
        const baseISO = (lead.data_valor || '').split(' ')[0] || todayISO();
        const addMonths = (iso, m) => {
            const d = new Date(iso + 'T00:00:00');
            d.setMonth(d.getMonth() + m);
            return d.toISOString().split('T')[0];
        };
        const pagoEmLead = (lead.data_pagamento || '').split(' ')[0]
            || (lead.data_valor || '').split(' ')[0] || todayISO();

        // Divisão em centavos sem perder resto (mesma convenção do POST /api/pagamentos).
        const baseC = Math.floor(cents / N);
        const resto = cents - baseC * N;

        // Quantas parcelas o valor_recebido cobre (na ordem). Sem "Nx" e em
        // col-ganho, a linha única conta como paga (comportamento anterior).
        let pagasCobertas = 0, acc = 0;
        for (let i = 0; i < N; i++) {
            acc += baseC + (i < resto ? 1 : 0);
            if (recCents > 0 && recCents >= acc) pagasCobertas = i + 1;
        }
        if (N === 1 && recCents === 0 && lead.column_id === 'col-ganho') pagasCobertas = 1;

        let mudou = false;
        for (let i = 0; i < N; i++) {
            const parcela = i + 1;
            const pcents = baseC + (i < resto ? 1 : 0);
            const querPago = parcela <= pagasCobertas;
            const row = porParcela.get(parcela);
            if (row && row.status === 'cancelado') continue; // estorno manual — não ressuscita

            if (!row) {
                const venc = querPago ? null : addMonths(baseISO, parcela);
                await queryD1(
                    `INSERT INTO crm_pagamentos
                       (lead_id, descricao, paciente, valor_centavos, tipo, forma_pagamento, status, vencimento, pago_em, parcela, parcelas_total, criado_por, origem_sync)
                     VALUES (?, ?, ?, ?, 'recebimento', ?, ?, ?, ?, ?, ?, ?, 'kanban')`,
                    [leadId, descricao, lead.nome || null, pcents, forma, querPago ? 'pago' : 'pendente',
                     venc, querPago ? pagoEmLead : null, parcela, N, orcadoPor]
                );
                mudou = true;
                continue;
            }

            // Transição de status nos dois sentidos.
            const novoStatus = querPago && row.status !== 'pago' ? 'pago'
                : !querPago && row.status === 'pago' ? 'pendente'
                : row.status;
            const novoPagoEm = novoStatus === 'pago' ? (row.pago_em || pagoEmLead) : null;
            const novoVenc = novoStatus === 'pago' ? null : addMonths(baseISO, parcela);

            const igual =
                Number(row.valor_centavos) === pcents &&
                row.status === novoStatus &&
                (row.descricao || '') === descricao &&
                (row.paciente || '') === (lead.nome || '') &&
                Number(row.parcelas_total || 1) === N &&
                (row.vencimento || null) === (novoVenc || null) &&
                (row.pago_em || null) === (novoPagoEm || null) &&
                (!forma || row.forma_pagamento === forma) &&
                (!orcadoPor || row.criado_por === orcadoPor);
            if (igual) continue;

            const sets = ['valor_centavos = ?', 'paciente = ?', 'descricao = ?', 'parcelas_total = ?',
                'status = ?', 'pago_em = ?', 'vencimento = ?'];
            const params = [pcents, lead.nome || null, descricao, N, novoStatus, novoPagoEm, novoVenc];
            if (forma) { sets.push('forma_pagamento = ?'); params.push(forma); }
            if (orcadoPor && row.criado_por !== orcadoPor) { sets.push('criado_por = ?'); params.push(orcadoPor); }
            params.push(row.id);
            await queryD1(`UPDATE crm_pagamentos SET ${sets.join(', ')} WHERE id = ?`, params);
            mudou = true;
        }

        // Parcelas sobrando (o "Nx" diminuiu) — apaga as não canceladas.
        for (const [parcela, row] of porParcela) {
            if (parcela > N && row.status !== 'cancelado') {
                await queryD1('DELETE FROM crm_pagamentos WHERE id = ?', [row.id]);
                mudou = true;
            }
        }

        if (mudou) await logSyncPag(leadId, gatilho, `sync`, `${cents}c/${N}x/${pagasCobertas}pg/col=${lead.column_id}`);
    } catch (e) {
        console.warn('[financeiro] syncLeadPagamento falhou para lead', leadId, '-', e.message);
    }
}

// Fila de retry: syncLeadPagamento engole os próprios erros, então a chamada
// inline "sempre passa". Se o D1 falhou, o id fica marcado e um worker (só no
// processo persistente) reprocessa. Na Vercel não há loop — o inline basta e o
// botão /api/financeiro/sync-kanban continua sendo o reparo manual.
const _dirtyLeadPag = new Set();
function markLeadPagDirty(id) { if (id) _dirtyLeadPag.add(String(id)); }
if (!process.env.VERCEL) {
    setInterval(async () => {
        if (!_dirtyLeadPag.size) return;
        const batch = [..._dirtyLeadPag];
        _dirtyLeadPag.clear();
        for (const id of batch) {
            try { await syncLeadPagamento(id, 'retry'); } catch (e) {}
        }
    }, 25000);
}

async function backfillKanbanPagamentos() {
    try {
        const leads = await queryD1(
            "SELECT id FROM leads WHERE (valor_recebido IS NOT NULL AND valor_recebido > 0) OR (orcamento IS NOT NULL AND orcamento != '' AND orcamento != '[]')"
        );
        for (const l of leads) await syncLeadPagamento(l.id);
        if (leads.length) console.log(`[financeiro] espelho Kanban->pagamentos: ${leads.length} lead(s) sincronizado(s).`);
    } catch (e) {
        console.warn('[financeiro] backfill Kanban->pagamentos falhou (repete no próximo boot):', e.message);
    }
}
// --- Sincronia Kanban <-> Financeiro ---
// Migrações + dedup + backfill numa sequência ÚNICA e ordenada: syncLeadPagamento
// já lê `origem_sync` e `data_pagamento` e grava em `crm_sync_log`, então essas
// estruturas têm que existir ANTES do backfill rodar.
(async () => {
    try {
        await queryD1("ALTER TABLE crm_pagamentos ADD COLUMN origem_sync TEXT").catch(() => {});
        await queryD1("ALTER TABLE leads ADD COLUMN data_pagamento DATETIME").catch(() => {});
        // Endereço estruturado do lead — necessário pra emitir boleto no PSP
        // (CEP + número não saem de um campo de texto livre).
        for (const col of ['cep TEXT', 'logradouro TEXT', 'numero TEXT', 'complemento TEXT', 'bairro TEXT', 'cidade TEXT', 'uf TEXT']) {
            await queryD1(`ALTER TABLE leads ADD COLUMN ${col}`).catch(() => {});
        }
        // Cobrança PSP (Pix/boleto) por fatura — colunas aditivas, ficam NULL até
        // alguém gerar a cobrança daquela parcela.
        for (const col of [
            'psp_provider TEXT', 'psp_charge_id TEXT', 'psp_metodo TEXT',
            'psp_qrcode TEXT', 'psp_qrcode_img TEXT', 'psp_url TEXT',
            'psp_linha_digitavel TEXT', 'psp_expira_em TEXT', 'psp_status TEXT',
            'psp_criado_em DATETIME', 'psp_raw TEXT'
        ]) {
            await queryD1(`ALTER TABLE crm_pagamentos ADD COLUMN ${col}`).catch(() => {});
        }
        await queryD1(`CREATE TABLE IF NOT EXISTS crm_sync_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lead_id TEXT, gatilho TEXT, antes TEXT, depois TEXT,
            ts DATETIME DEFAULT CURRENT_TIMESTAMP
        )`).catch(() => {});
        await queryD1("UPDATE crm_pagamentos SET origem_sync = 'kanban' WHERE criado_por = 'kanban' AND (origem_sync IS NULL OR origem_sync = '')").catch(() => {});
        await queryD1("UPDATE crm_pagamentos SET origem_sync = 'manual' WHERE origem_sync IS NULL OR origem_sync = ''").catch(() => {});

        // Mescla espelhos Kanban duplicados por (lead, parcela) — corrida antiga.
        // Chave por parcela: um plano parcelado tem N linhas 'kanban' legítimas.
        const dups = await queryD1(
            "SELECT lead_id, parcela FROM crm_pagamentos WHERE origem_sync = 'kanban' AND lead_id IS NOT NULL GROUP BY lead_id, parcela HAVING COUNT(*) > 1"
        );
        for (const d of dups) {
            const rows = await queryD1("SELECT id FROM crm_pagamentos WHERE origem_sync = 'kanban' AND lead_id = ? AND parcela = ? ORDER BY id DESC", [d.lead_id, d.parcela]);
            const drop = rows.slice(1).map(r => r.id);
            if (drop.length) await queryD1(`DELETE FROM crm_pagamentos WHERE id IN (${drop.map(() => '?').join(',')})`, drop);
        }
        if (dups.length) console.log(`[financeiro] ${dups.length} (lead,parcela) com espelho duplicado — mesclado.`);
        // Índice antigo era ON (lead_id); agora precisa distinguir parcelas -> recria.
        await queryD1("DROP INDEX IF EXISTS idx_pag_kanban_unico").catch(() => {});
        await queryD1("CREATE UNIQUE INDEX IF NOT EXISTS idx_pag_kanban_unico ON crm_pagamentos(lead_id, parcela) WHERE origem_sync = 'kanban'").catch(() => {});
        // Badge de vencidas (GET /api/financeiro/vencido): range scan em vez de varrer a tabela.
        await queryD1("CREATE INDEX IF NOT EXISTS idx_pag_status_venc ON crm_pagamentos(status, vencimento)").catch(() => {});

        // Trilha de sync: mantém ~800 linhas (ring).
        await queryD1("DELETE FROM crm_sync_log WHERE id <= (SELECT MAX(id) - 800 FROM crm_sync_log)").catch(() => {});

        // Re-sync em massa só no processo persistente — na Vercel cada cold start
        // rodaria isso à toa (as edições de card mantêm tudo em dia, e
        // /api/financeiro/sync-kanban é o reparo manual completo).
        if (!process.env.VERCEL) await backfillKanbanPagamentos();
    } catch (e) {
        console.warn('[financeiro] setup da sincronia Kanban<->Financeiro:', e.message);
    }
})();

// Configurações simples de chave/valor (ex.: meta de receita do dashboard) —
// evita criar uma tabela dedicada pra cada configuração pontual do sistema.
queryD1(`CREATE TABLE IF NOT EXISTS crm_settings (
    key TEXT PRIMARY KEY,
    value TEXT
)`).catch(() => {});

// ==========================================
// EMPRESAS / EMITENTES — dados que vão no cabeçalho do orçamento impresso
// (e futuramente recibos/contratos). Substitui a chave única
// crm_settings.'orcamento_empresa' por um cadastro com várias empresas, uma
// marcada como padrão.
// ==========================================
queryD1(`CREATE TABLE IF NOT EXISTS crm_empresas (
    id TEXT PRIMARY KEY,
    razao_social TEXT NOT NULL,
    nome_fantasia TEXT,
    cnpj TEXT,
    inscricao_estadual TEXT,
    inscricao_municipal TEXT,
    endereco TEXT,
    telefone TEXT,
    email TEXT,
    site TEXT,
    responsavel_tecnico TEXT,
    dados_pagamento TEXT,
    logo TEXT,
    is_default INTEGER DEFAULT 0,
    ativo INTEGER DEFAULT 1,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).then(async () => {
    // Migração automática: se a tabela está vazia mas já existe a empresa única
    // no formato antigo (crm_settings.orcamento_empresa), traz ela pra cá como a
    // primeira empresa e marca como padrão — o impresso continua idêntico, sem
    // nenhum passo manual.
    try {
        const existing = await queryD1('SELECT id FROM crm_empresas LIMIT 1');
        if (!existing || existing.length === 0) {
            const rows = await queryD1("SELECT value FROM crm_settings WHERE key = 'orcamento_empresa'");
            let old = {};
            if (rows && rows[0] && rows[0].value) { try { old = JSON.parse(rows[0].value) || {}; } catch (e) {} }
            if (old.razao_social || old.cnpj || old.logo) {
                await queryD1(
                    `INSERT INTO crm_empresas (id, razao_social, cnpj, endereco, telefone, email, logo, is_default, ativo)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`,
                    [`emp-${Date.now()}`, old.razao_social || 'Minha Empresa', old.cnpj || '', old.endereco || '',
                     old.telefone || '', old.email || '', old.logo || '']
                );
            }
        }
    } catch (e) {
        console.error('Erro ao migrar empresa padrão:', e);
    }
}).catch(() => {});

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

// Layout padrão do dashboard (Personalizar > Definir como Padrão) — antes só
// existia no localStorage de quem clicava, então cada atendente via um "padrão"
// diferente e o card ficava desalinhado assim que outro navegador nunca tinha
// customizado nada e caía no arranjo de fábrica em vez do que o admin escolheu.
app.get('/api/settings/dashboard-layout', async (req, res) => {
    try {
        const rows = await queryD1("SELECT value FROM crm_settings WHERE key = 'dashboard_default_layout'");
        let layout = null;
        if (rows && rows[0] && rows[0].value) {
            try { layout = JSON.parse(rows[0].value); } catch (e) {}
        }
        res.json({ layout });
    } catch (e) {
        console.error('Erro ao buscar layout padrão do dashboard:', e);
        res.status(500).json({ error: 'Erro interno ao buscar layout.' });
    }
});

app.put('/api/settings/dashboard-layout', async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradores podem definir o layout padrão pra todos.' });
    }
    try {
        const { layout } = req.body || {};
        if (!layout || !Array.isArray(layout.cards)) {
            return res.status(400).json({ error: 'Layout inválido.' });
        }
        await queryD1(
            "INSERT INTO crm_settings (key, value) VALUES ('dashboard_default_layout', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [JSON.stringify(layout)]
        );
        res.json({ success: true, layout });
    } catch (e) {
        console.error('Erro ao salvar layout padrão do dashboard:', e);
        res.status(500).json({ error: 'Erro interno ao salvar layout.' });
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

// Tarifas do disparo de WhatsApp (R$ por mensagem, por categoria de template) —
// desde jan/2026 a Meta cobra por mensagem enviada (não mais por conversa de
// 24h), com valor fixo por categoria. Editável porque a Meta pode reajustar.
const DEFAULT_WHATSAPP_PRICING = { MARKETING: 0.3125, UTILITY: 0.0340, AUTHENTICATION: 0.0340 };

app.get('/api/settings/whatsapp-pricing', async (req, res) => {
    try {
        const rows = await queryD1("SELECT value FROM crm_settings WHERE key = 'whatsapp_pricing_rates'");
        let rates = DEFAULT_WHATSAPP_PRICING;
        if (rows && rows[0] && rows[0].value) {
            try { rates = { ...DEFAULT_WHATSAPP_PRICING, ...JSON.parse(rows[0].value) }; } catch (e) {}
        }
        res.json({ rates });
    } catch (e) {
        console.error('Erro ao buscar tarifas do WhatsApp:', e);
        res.status(500).json({ error: 'Erro interno ao buscar tarifas.' });
    }
});

app.put('/api/settings/whatsapp-pricing', async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradores podem definir tarifas.' });
    }
    try {
        const { MARKETING, UTILITY, AUTHENTICATION } = req.body || {};
        const rates = {
            MARKETING: parseFloat(MARKETING),
            UTILITY: parseFloat(UTILITY),
            AUTHENTICATION: parseFloat(AUTHENTICATION)
        };
        for (const key of Object.keys(rates)) {
            if (isNaN(rates[key]) || rates[key] < 0) {
                return res.status(400).json({ error: `Tarifa inválida para ${key}.` });
            }
        }
        await queryD1(
            "INSERT INTO crm_settings (key, value) VALUES ('whatsapp_pricing_rates', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [JSON.stringify(rates)]
        );
        res.json({ success: true, rates });
    } catch (e) {
        console.error('Erro ao salvar tarifas do WhatsApp:', e);
        res.status(500).json({ error: 'Erro interno ao salvar tarifas.' });
    }
});

// Interruptor geral do agente de IA de pré-qualificação — além do controle
// por lead (leads.ai_enabled), esse é o "desliga tudo" de emergência/manutenção.
// Tempo (em segundos) que a IA espera antes de mandar a resposta automática —
// deixa a conversa mais humana e dá uma janela pra um atendente assumir. É
// limitado a WHATSAPP_AI_MAX_DELAY: como a resposta ainda é gerada dentro do
// webhook (função serverless), um valor alto faz o WhatsApp reentregar a mensagem.
const WHATSAPP_AI_MAX_DELAY = 15;
function clampAiDelay(v) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(n, WHATSAPP_AI_MAX_DELAY);
}
async function getWhatsappAiReplyDelay() {
    const rows = await queryD1("SELECT value FROM crm_settings WHERE key = 'whatsapp_ai_reply_delay'");
    return rows && rows[0] ? clampAiDelay(rows[0].value) : 0;
}

app.get('/api/settings/whatsapp-ai', async (req, res) => {
    try {
        const rows = await queryD1("SELECT value FROM crm_settings WHERE key = 'whatsapp_ai_enabled'");
        const enabled = rows && rows[0] ? rows[0].value === '1' : true; // liga por padrão
        const delaySeconds = await getWhatsappAiReplyDelay();
        const mode = await getWhatsappAiMode();
        const timing = await getWhatsappAiTiming();
        res.json({ enabled, delaySeconds, mode, maxDelaySeconds: WHATSAPP_AI_MAX_DELAY, human: timing.human, typing: timing.typing, vision: await getWhatsappAiVision(), audio: await getWhatsappAiAudio() });
    } catch (e) {
        console.error('Erro ao buscar configuração da IA do WhatsApp:', e);
        res.status(500).json({ error: 'Erro interno ao buscar configuração.' });
    }
});

app.put('/api/settings/whatsapp-ai', async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradores podem ligar/desligar a IA.' });
    }
    try {
        const enabled = req.body?.enabled ? '1' : '0';
        await queryD1(
            "INSERT INTO crm_settings (key, value) VALUES ('whatsapp_ai_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [enabled]
        );
        let delaySeconds;
        if (req.body?.delaySeconds !== undefined) {
            delaySeconds = clampAiDelay(req.body.delaySeconds);
            await queryD1(
                "INSERT INTO crm_settings (key, value) VALUES ('whatsapp_ai_reply_delay', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [String(delaySeconds)]
            );
        } else {
            delaySeconds = await getWhatsappAiReplyDelay();
        }
        let mode = await getWhatsappAiMode();
        if (req.body?.mode !== undefined) {
            mode = req.body.mode === 'vendas' ? 'vendas' : 'qualificacao';
            await queryD1(
                "INSERT INTO crm_settings (key, value) VALUES ('whatsapp_ai_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [mode]
            );
        }
        for (const k of ['human', 'typing', 'vision', 'audio']) {
            if (req.body?.[k] !== undefined) {
                await queryD1(
                    `INSERT INTO crm_settings (key, value) VALUES ('whatsapp_ai_${k}', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                    [req.body[k] ? '1' : '0']
                );
            }
        }
        const timing = await getWhatsappAiTiming();
        res.json({ success: true, enabled: enabled === '1', delaySeconds, mode, human: timing.human, typing: timing.typing, vision: await getWhatsappAiVision(), audio: await getWhatsappAiAudio() });
    } catch (e) {
        console.error('Erro ao salvar configuração da IA do WhatsApp:', e);
        res.status(500).json({ error: 'Erro interno ao salvar configuração.' });
    }
});

// ==========================================
// EMPRESAS / EMITENTES — CRUD
// Leitura: qualquer usuário logado (o atendente precisa escolher a empresa ao
// imprimir um orçamento). Escrita: só admin, igual /api/unidades.
// ==========================================
const EMPRESA_LOGO_RE = /^data:image\/(png|jpeg|jpg|webp|svg\+xml);/i;

// Normaliza o corpo da requisição num objeto de colunas de texto da crm_empresas.
function empresaFieldsFromBody(b) {
    const s = (v) => String(v || '').trim();
    return {
        razao_social: s(b.razao_social),
        nome_fantasia: s(b.nome_fantasia),
        cnpj: s(b.cnpj),
        inscricao_estadual: s(b.inscricao_estadual),
        inscricao_municipal: s(b.inscricao_municipal),
        endereco: s(b.endereco),
        telefone: s(b.telefone),
        email: s(b.email),
        site: s(b.site),
        responsavel_tecnico: s(b.responsavel_tecnico),
        dados_pagamento: s(b.dados_pagamento)
    };
}

// Resolve a empresa que deve aparecer no orçamento de um lead:
// a escolhida no lead -> a padrão -> a primeira ativa -> null.
async function resolveEmpresaParaLead(empresaId) {
    try {
        if (empresaId) {
            const rows = await queryD1('SELECT * FROM crm_empresas WHERE id = ? AND ativo = 1', [empresaId]);
            if (rows && rows[0]) return rows[0];
        }
        const def = await queryD1('SELECT * FROM crm_empresas WHERE ativo = 1 ORDER BY is_default DESC, created_at ASC LIMIT 1');
        return (def && def[0]) || null;
    } catch (e) {
        console.error('Erro ao resolver empresa do lead:', e);
        return null;
    }
}

app.get('/api/empresas', async (req, res) => {
    try {
        const rows = await queryD1('SELECT * FROM crm_empresas ORDER BY is_default DESC, created_at ASC');
        res.json({ empresas: rows || [] });
    } catch (e) {
        console.error('Erro ao listar empresas:', e);
        res.status(500).json({ error: 'Erro interno ao listar empresas.' });
    }
});

app.post('/api/empresas', async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradores podem cadastrar empresas.' });
    }
    try {
        const f = empresaFieldsFromBody(req.body || {});
        if (!f.razao_social) return res.status(400).json({ error: 'Razão social é obrigatória.' });

        let logo = '';
        if (req.body.logo !== undefined && String(req.body.logo) !== '') {
            logo = String(req.body.logo);
            if (!EMPRESA_LOGO_RE.test(logo)) return res.status(400).json({ error: 'Formato de logo inválido.' });
            if (logo.length > 700000) return res.status(413).json({ error: 'Logo muito pesada. Envie uma imagem menor.' });
        }

        // A primeira empresa cadastrada, ou um pedido explícito, vira a padrão.
        const total = await queryD1('SELECT COUNT(*) as total FROM crm_empresas');
        const makeDefault = (total?.[0]?.total || 0) === 0 || req.body.is_default === true || req.body.is_default === 1;

        const id = `emp-${Date.now()}`;
        if (makeDefault) await queryD1('UPDATE crm_empresas SET is_default = 0');

        await queryD1(
            `INSERT INTO crm_empresas
             (id, razao_social, nome_fantasia, cnpj, inscricao_estadual, inscricao_municipal, endereco, telefone, email, site, responsavel_tecnico, dados_pagamento, logo, is_default, ativo, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
            [id, f.razao_social, f.nome_fantasia, f.cnpj, f.inscricao_estadual, f.inscricao_municipal, f.endereco,
             f.telefone, f.email, f.site, f.responsavel_tecnico, f.dados_pagamento, logo, makeDefault ? 1 : 0,
             req.user?.username || null]
        );
        res.status(201).json({ success: true, id });
    } catch (e) {
        console.error('Erro ao criar empresa:', e);
        res.status(500).json({ error: 'Erro interno ao criar empresa.' });
    }
});

app.put('/api/empresas/:id', async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradores podem editar empresas.' });
    }
    try {
        const rows = await queryD1('SELECT id FROM crm_empresas WHERE id = ?', [req.params.id]);
        if (!rows || !rows[0]) return res.status(404).json({ error: 'Empresa não encontrada.' });

        const f = empresaFieldsFromBody(req.body || {});
        if (!f.razao_social) return res.status(400).json({ error: 'Razão social é obrigatória.' });

        const updates = [
            'razao_social = ?', 'nome_fantasia = ?', 'cnpj = ?', 'inscricao_estadual = ?',
            'inscricao_municipal = ?', 'endereco = ?', 'telefone = ?', 'email = ?', 'site = ?',
            'responsavel_tecnico = ?', 'dados_pagamento = ?'
        ];
        const params = [
            f.razao_social, f.nome_fantasia, f.cnpj, f.inscricao_estadual, f.inscricao_municipal,
            f.endereco, f.telefone, f.email, f.site, f.responsavel_tecnico, f.dados_pagamento
        ];

        // logo: undefined = não mexeram; '' = remover; data URI = trocar.
        if (req.body.logo !== undefined) {
            const logo = String(req.body.logo || '');
            if (logo === '') {
                updates.push('logo = ?'); params.push('');
            } else if (EMPRESA_LOGO_RE.test(logo)) {
                if (logo.length > 700000) return res.status(413).json({ error: 'Logo muito pesada. Envie uma imagem menor.' });
                updates.push('logo = ?'); params.push(logo);
            } else {
                return res.status(400).json({ error: 'Formato de logo inválido.' });
            }
        }

        if (req.body.ativo !== undefined) {
            updates.push('ativo = ?'); params.push(req.body.ativo ? 1 : 0);
        }

        params.push(req.params.id);
        await queryD1(`UPDATE crm_empresas SET ${updates.join(', ')} WHERE id = ?`, params);
        res.json({ success: true });
    } catch (e) {
        console.error('Erro ao editar empresa:', e);
        res.status(500).json({ error: 'Erro interno ao editar empresa.' });
    }
});

app.patch('/api/empresas/:id/default', async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradores podem definir a empresa padrão.' });
    }
    try {
        const rows = await queryD1('SELECT id FROM crm_empresas WHERE id = ?', [req.params.id]);
        if (!rows || !rows[0]) return res.status(404).json({ error: 'Empresa não encontrada.' });
        await queryD1('UPDATE crm_empresas SET is_default = 0');
        await queryD1('UPDATE crm_empresas SET is_default = 1, ativo = 1 WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        console.error('Erro ao definir empresa padrão:', e);
        res.status(500).json({ error: 'Erro interno.' });
    }
});

app.delete('/api/empresas/:id', async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradores podem excluir empresas.' });
    }
    try {
        const all = await queryD1('SELECT id, is_default FROM crm_empresas');
        if ((all?.length || 0) <= 1) {
            return res.status(400).json({ error: 'Não é possível excluir a única empresa cadastrada.' });
        }
        const alvo = all.find(e => e.id === req.params.id);
        if (!alvo) return res.status(404).json({ error: 'Empresa não encontrada.' });

        await queryD1('DELETE FROM crm_empresas WHERE id = ?', [req.params.id]);
        // Leads que apontavam pra ela voltam a resolver pela padrão.
        await queryD1('UPDATE leads SET empresa_id = NULL WHERE empresa_id = ?', [req.params.id]);

        // Se apagou a padrão, promove a mais antiga ativa que sobrou.
        if (alvo.is_default) {
            const prox = await queryD1('SELECT id FROM crm_empresas WHERE ativo = 1 ORDER BY created_at ASC LIMIT 1');
            if (prox && prox[0]) await queryD1('UPDATE crm_empresas SET is_default = 1 WHERE id = ?', [prox[0].id]);
        }
        res.json({ success: true });
    } catch (e) {
        console.error('Erro ao excluir empresa:', e);
        res.status(500).json({ error: 'Erro interno ao excluir empresa.' });
    }
});

// Consulta pública de CNPJ (BrasilAPI) — pré-preenche o formulário de cadastro.
// Falha graciosamente: se cair, o cadastro manual continua funcionando.
app.get('/api/empresas/lookup-cnpj/:cnpj', async (req, res) => {
    const digits = String(req.params.cnpj || '').replace(/\D/g, '');
    if (digits.length !== 14) return res.status(400).json({ error: 'CNPJ inválido.' });
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${digits}`, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!r.ok) {
            return res.status(r.status === 404 ? 404 : 502)
                .json({ error: r.status === 404 ? 'CNPJ não encontrado.' : 'Consulta indisponível agora.' });
        }
        const d = await r.json();
        const endereco = [
            [d.logradouro, d.numero].filter(Boolean).join(', '),
            d.complemento, d.bairro,
            [d.municipio, d.uf].filter(Boolean).join(' - '),
            d.cep
        ].filter(Boolean).join(', ');
        res.json({
            empresa: {
                razao_social: d.razao_social || '',
                nome_fantasia: d.nome_fantasia || '',
                cnpj: digits,
                endereco,
                telefone: d.ddd_telefone_1 || '',
                email: d.email || ''
            }
        });
    } catch (e) {
        console.error('Erro no lookup de CNPJ:', e.message);
        res.status(502).json({ error: 'Consulta de CNPJ indisponível agora.' });
    }
});

// --- Compat: endpoints antigos (formato de empresa única) apontam pra empresa
// padrão do novo cadastro. Deprecados; o front novo usa /api/empresas. ---
app.get('/api/settings/orcamento-empresa', async (req, res) => {
    try {
        const emp = await resolveEmpresaParaLead(null);
        res.json({ empresa: emp || {} });
    } catch (e) {
        console.error('Erro ao buscar dados da empresa:', e);
        res.status(500).json({ error: 'Erro interno.' });
    }
});

app.put('/api/settings/orcamento-empresa', async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradores podem editar os dados da empresa.' });
    }
    try {
        const b = req.body || {};
        const f = empresaFieldsFromBody(b);

        let setLogo = false, logoParam = '';
        if (b.logo !== undefined) {
            const logo = String(b.logo || '');
            if (logo === '') { setLogo = true; logoParam = ''; }
            else if (EMPRESA_LOGO_RE.test(logo)) {
                if (logo.length > 700000) return res.status(413).json({ error: 'Logo muito pesada. Envie uma imagem menor.' });
                setLogo = true; logoParam = logo;
            } else return res.status(400).json({ error: 'Formato de logo inválido.' });
        }

        const def = await queryD1('SELECT * FROM crm_empresas WHERE ativo = 1 ORDER BY is_default DESC, created_at ASC LIMIT 1');
        if (def && def[0]) {
            const cols = ['razao_social = ?', 'cnpj = ?', 'endereco = ?', 'telefone = ?', 'email = ?'];
            const ps = [f.razao_social || def[0].razao_social, f.cnpj, f.endereco, f.telefone, f.email];
            if (setLogo) { cols.push('logo = ?'); ps.push(logoParam); }
            ps.push(def[0].id);
            await queryD1(`UPDATE crm_empresas SET ${cols.join(', ')} WHERE id = ?`, ps);
        } else {
            await queryD1(
                `INSERT INTO crm_empresas (id, razao_social, cnpj, endereco, telefone, email, logo, is_default, ativo)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`,
                [`emp-${Date.now()}`, f.razao_social || 'Minha Empresa', f.cnpj, f.endereco, f.telefone, f.email, setLogo ? logoParam : '']
            );
        }
        res.json({ success: true });
    } catch (e) {
        console.error('Erro ao salvar dados da empresa (compat):', e);
        res.status(500).json({ error: 'Erro interno.' });
    }
});

// Contexto editável da IA (identidade, unidades, horário, serviços, tom) —
// a regra crítica de silêncio (WHATSAPP_AI_SILENCE_RULE) NÃO é editável por
// aqui, é sempre anexada pelo backend, pra ninguém quebrar o mecanismo de
// handoff sem querer ao editar o texto.
app.get('/api/settings/whatsapp-ai-context', async (req, res) => {
    try {
        const context = await getWhatsappAiContext();
        res.json({ context });
    } catch (e) {
        console.error('Erro ao buscar contexto da IA:', e);
        res.status(500).json({ error: 'Erro interno ao buscar contexto.' });
    }
});

app.put('/api/settings/whatsapp-ai-context', async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradores podem editar o contexto da IA.' });
    }
    try {
        const context = (req.body?.context || '').trim();
        if (!context) {
            return res.status(400).json({ error: 'O contexto não pode ficar vazio.' });
        }
        await queryD1(
            "INSERT INTO crm_settings (key, value) VALUES ('whatsapp_ai_context', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [context]
        );
        res.json({ success: true });
    } catch (e) {
        console.error('Erro ao salvar contexto da IA:', e);
        res.status(500).json({ error: 'Erro interno ao salvar contexto.' });
    }
});

// Etiquetas de lead (compartilhadas entre todos os atendentes) — antes viviam
// só no localStorage do navegador de quem criava, então um lead marcado com
// uma etiqueta custom não mostrava nada pra quem abrisse o CRM em outro
// dispositivo (a etiqueta simplesmente não existia lá).
app.get('/api/settings/whatsapp-tags', async (req, res) => {
    try {
        const rows = await queryD1("SELECT value FROM crm_settings WHERE key = 'whatsapp_custom_tags'");
        let tags = [];
        if (rows && rows[0] && rows[0].value) {
            try { tags = JSON.parse(rows[0].value); } catch (e) {}
        }
        res.json({ tags: Array.isArray(tags) ? tags : [] });
    } catch (e) {
        console.error('Erro ao buscar etiquetas:', e);
        res.status(500).json({ error: 'Erro interno ao buscar etiquetas.' });
    }
});

app.put('/api/settings/whatsapp-tags', async (req, res) => {
    try {
        const { tags } = req.body || {};
        if (!Array.isArray(tags)) {
            return res.status(400).json({ error: 'Lista de etiquetas inválida.' });
        }
        await queryD1(
            "INSERT INTO crm_settings (key, value) VALUES ('whatsapp_custom_tags', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [JSON.stringify(tags)]
        );
        res.json({ success: true, tags });
    } catch (e) {
        console.error('Erro ao salvar etiquetas:', e);
        res.status(500).json({ error: 'Erro interno ao salvar etiquetas.' });
    }
});

// Histórico de disparos em massa (campanhas de template) — cada linha é um
// disparo concluído, com o custo estimado já calculado no front (soma de
// sucessos × tarifa da categoria do template no momento do envio).
queryD1(`CREATE TABLE IF NOT EXISTS wa_dispatches (
    id TEXT PRIMARY KEY,
    template_name TEXT,
    category TEXT,
    target_column TEXT,
    total_leads INTEGER DEFAULT 0,
    success_count INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0,
    cost_total REAL DEFAULT 0,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});

// Liga/desliga o agente de IA de pré-qualificação por lead — auto-executável
// (não preso na rota manual /api/init-db) pra nunca cair no mesmo problema do
// lead_audiences, que ficou meses sem existir em produção por depender de
// alguém chamar aquela rota manualmente.
queryD1('ALTER TABLE leads ADD COLUMN ai_enabled INTEGER DEFAULT 1').catch(() => {});

// Empresa/emitente escolhida pra este lead no orçamento impresso (cadastro crm_empresas).
queryD1('ALTER TABLE leads ADD COLUMN empresa_id TEXT').catch(() => {});

// Timestamp de quando a IA marcou o lead como "quente" (tag ia-qualificado) —
// alimenta o badge de "leads quentes esperando atendimento" no chat. Fica NULL
// de novo assim que alguém atende (manda mensagem manual ou faz handoff-ai).
queryD1('ALTER TABLE leads ADD COLUMN qualificado_em DATETIME').catch(() => {});

// Guarda qual atendente fechou (criou) o orçamento, pra aparecer no relatório de Histórico.
queryD1('ALTER TABLE agendamentos_financeiro ADD COLUMN orcado_por TEXT').catch(() => {});

app.post('/api/whatsapp/dispatches', async (req, res) => {
    try {
        const { template_name, category, target_column, total_leads, success_count, fail_count, cost_total } = req.body || {};
        if (!template_name) {
            return res.status(400).json({ error: 'Nome do template é obrigatório.' });
        }
        const id = `disp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await queryD1(
            'INSERT INTO wa_dispatches (id, template_name, category, target_column, total_leads, success_count, fail_count, cost_total, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [id, template_name, category || null, target_column || null, total_leads || 0, success_count || 0, fail_count || 0, cost_total || 0, req.user?.username || null]
        );
        res.status(201).json({ success: true, id });
    } catch (e) {
        console.error('Erro ao salvar disparo:', e);
        res.status(500).json({ error: 'Erro interno ao salvar disparo.' });
    }
});

app.get('/api/whatsapp/dispatches', async (req, res) => {
    try {
        const rows = await queryD1('SELECT * FROM wa_dispatches ORDER BY created_at DESC LIMIT 50');
        res.json({ dispatches: rows || [] });
    } catch (e) {
        console.error('Erro ao listar disparos:', e);
        res.status(500).json({ error: 'Erro interno ao listar disparos.' });
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
// Atalho "/" opcional pra disparar o áudio direto do campo de mensagem.
queryD1('ALTER TABLE crm_voice_library ADD COLUMN comando TEXT').catch(() => {});

// Normaliza o comando: sem "/", minúsculo, sem espaço, só [a-z0-9_-]. Vazio → null.
function normalizeVoiceCmd(v) {
    if (!v) return null;
    const s = String(v).trim().replace(/^\/+/, '').toLowerCase()
        .replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
    return s || null;
}

app.get('/api/voice-library', async (req, res) => {
    try {
        const rows = await queryD1('SELECT id, nome, comando, duration_seconds, created_by, created_at FROM crm_voice_library ORDER BY created_at DESC');
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
        const comando = normalizeVoiceCmd(req.body.comando);
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
            'INSERT INTO crm_voice_library (id, nome, comando, audio_base64, duration_seconds, created_by) VALUES (?, ?, ?, ?, ?, ?)',
            [id, nome.trim(), comando, buffer.toString('base64'), duration_seconds || null, req.user?.username || null]
        );
        res.status(201).json({ success: true, id, comando });
    } catch (e) {
        console.error('Erro ao salvar áudio na biblioteca:', e);
        res.status(500).json({ error: e.message || 'Erro interno ao salvar áudio.' });
    }
});

// Renomear / definir o comando "/" de um áudio já salvo.
app.put('/api/voice-library/:id', async (req, res) => {
    try {
        const rows = await queryD1('SELECT id FROM crm_voice_library WHERE id = ?', [req.params.id]);
        if (!rows || rows.length === 0) return res.status(404).json({ error: 'Áudio não encontrado.' });

        const nome = (req.body.nome || '').trim();
        if (!nome) return res.status(400).json({ error: 'O nome não pode ficar vazio.' });
        const comando = normalizeVoiceCmd(req.body.comando);

        await queryD1('UPDATE crm_voice_library SET nome = ?, comando = ? WHERE id = ?', [nome, comando, req.params.id]);
        res.json({ success: true, nome, comando });
    } catch (e) {
        console.error('Erro ao atualizar áudio da biblioteca:', e);
        res.status(500).json({ error: e.message || 'Erro interno ao atualizar áudio.' });
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

// ==========================================
// BIBLIOTECA DE MÍDIA — pastas + arquivos (base64 no D1, mesmo padrão do voice)
// ==========================================
queryD1(`CREATE TABLE IF NOT EXISTS crm_media_folders (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    parent_id TEXT,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});
queryD1(`CREATE TABLE IF NOT EXISTS crm_media (
    id TEXT PRIMARY KEY,
    folder_id TEXT,
    nome TEXT NOT NULL,
    tipo TEXT,
    mime TEXT,
    tamanho_bytes INTEGER,
    data_base64 TEXT NOT NULL,
    thumb_base64 TEXT,
    legenda_padrao TEXT,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});

const MEDIA_MAX_BYTES = 4 * 1024 * 1024; // teto pra não estourar a linha do D1
function mediaTipoFromMime(m) {
    m = String(m || '');
    if (m.startsWith('image/')) return 'image';
    if (m.startsWith('video/')) return 'video';
    if (m.startsWith('audio/')) return 'audio';
    return 'document';
}
const MEDIA_LIST_COLS = 'id, folder_id, nome, tipo, mime, tamanho_bytes, thumb_base64, legenda_padrao, created_by, created_at';

app.get('/api/media', async (req, res) => {
    try {
        const folder = req.query.folder || null;
        const folders = await queryD1(
            folder ? 'SELECT id, nome, parent_id, created_at FROM crm_media_folders WHERE parent_id = ? ORDER BY nome'
                   : 'SELECT id, nome, parent_id, created_at FROM crm_media_folders WHERE parent_id IS NULL ORDER BY nome',
            folder ? [folder] : []
        );
        const items = await queryD1(
            folder ? `SELECT ${MEDIA_LIST_COLS} FROM crm_media WHERE folder_id = ? ORDER BY created_at DESC`
                   : `SELECT ${MEDIA_LIST_COLS} FROM crm_media WHERE folder_id IS NULL ORDER BY created_at DESC`,
            folder ? [folder] : []
        );
        let breadcrumb = [];
        if (folder) {
            const f = await queryD1('SELECT id, nome FROM crm_media_folders WHERE id = ?', [folder]);
            if (f && f[0]) breadcrumb = [{ id: f[0].id, nome: f[0].nome }];
        }
        res.json({ folders: folders || [], items: items || [], breadcrumb });
    } catch (e) {
        console.error('Erro ao listar mídias:', e);
        res.status(500).json({ error: 'Erro ao listar a biblioteca.' });
    }
});

app.get('/api/media/:id/raw', async (req, res) => {
    try {
        const rows = await queryD1('SELECT data_base64, mime, nome FROM crm_media WHERE id = ?', [req.params.id]);
        if (!rows || !rows[0]) return res.status(404).send('Mídia não encontrada.');
        res.set('Content-Type', rows[0].mime || 'application/octet-stream');
        res.set('Content-Disposition', `inline; filename="${String(rows[0].nome || 'arquivo').replace(/["\r\n]/g, '')}"`);
        res.send(Buffer.from(rows[0].data_base64, 'base64'));
    } catch (e) {
        console.error('Erro ao servir mídia:', e);
        res.status(500).send('Erro interno.');
    }
});

app.post('/api/media', async (req, res) => {
    try {
        const { nome, data, folder_id, legenda_padrao, thumb } = req.body;
        const m = String(data || '').match(/^data:(.*?);base64,(.*)$/s);
        if (!m) return res.status(400).json({ error: 'Arquivo inválido.' });
        const mime = m[1].split(';')[0].trim();
        const b64 = m[2];
        const bytes = Buffer.byteLength(b64, 'base64');
        if (bytes > MEDIA_MAX_BYTES) {
            return res.status(413).json({ error: `Arquivo grande demais (${(bytes/1024/1024).toFixed(1)} MB). Máx ${MEDIA_MAX_BYTES/1024/1024} MB nesta versão.` });
        }
        const id = `media-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        await queryD1(
            `INSERT INTO crm_media (id, folder_id, nome, tipo, mime, tamanho_bytes, data_base64, thumb_base64, legenda_padrao, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, folder_id || null, (nome || 'arquivo').trim(), mediaTipoFromMime(mime), mime, bytes, b64, thumb || null, legenda_padrao || null, req.user?.username || null]
        );
        res.status(201).json({ success: true, id });
    } catch (e) {
        console.error('Erro ao salvar mídia:', e);
        res.status(500).json({ error: e.message || 'Erro ao salvar o arquivo.' });
    }
});

app.put('/api/media/:id', async (req, res) => {
    try {
        const cur = await queryD1('SELECT id FROM crm_media WHERE id = ?', [req.params.id]);
        if (!cur || !cur[0]) return res.status(404).json({ error: 'Mídia não encontrada.' });
        const sets = [], params = [];
        if (req.body.nome !== undefined) { sets.push('nome = ?'); params.push(String(req.body.nome).trim() || 'arquivo'); }
        if (req.body.folder_id !== undefined) { sets.push('folder_id = ?'); params.push(req.body.folder_id || null); }
        if (req.body.legenda_padrao !== undefined) { sets.push('legenda_padrao = ?'); params.push(req.body.legenda_padrao || null); }
        if (!sets.length) return res.json({ success: true });
        params.push(req.params.id);
        await queryD1(`UPDATE crm_media SET ${sets.join(', ')} WHERE id = ?`, params);
        res.json({ success: true });
    } catch (e) {
        console.error('Erro ao atualizar mídia:', e);
        res.status(500).json({ error: 'Erro ao atualizar.' });
    }
});

app.delete('/api/media/:id', async (req, res) => {
    try {
        await queryD1('DELETE FROM crm_media WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        console.error('Erro ao excluir mídia:', e);
        res.status(500).json({ error: 'Erro ao excluir.' });
    }
});

app.post('/api/media/folders', async (req, res) => {
    try {
        const nome = (req.body.nome || '').trim();
        if (!nome) return res.status(400).json({ error: 'Dê um nome à pasta.' });
        const id = `fold-${Date.now()}`;
        await queryD1('INSERT INTO crm_media_folders (id, nome, parent_id, created_by) VALUES (?, ?, ?, ?)',
            [id, nome, req.body.parent_id || null, req.user?.username || null]);
        res.status(201).json({ success: true, id, nome });
    } catch (e) {
        console.error('Erro ao criar pasta:', e);
        res.status(500).json({ error: 'Erro ao criar a pasta.' });
    }
});

app.put('/api/media/folders/:id', async (req, res) => {
    try {
        const nome = (req.body.nome || '').trim();
        if (!nome) return res.status(400).json({ error: 'Nome inválido.' });
        await queryD1('UPDATE crm_media_folders SET nome = ? WHERE id = ?', [nome, req.params.id]);
        res.json({ success: true, nome });
    } catch (e) {
        console.error('Erro ao renomear pasta:', e);
        res.status(500).json({ error: 'Erro ao renomear.' });
    }
});

app.delete('/api/media/folders/:id', async (req, res) => {
    try {
        // conteúdo volta pra raiz e a pasta some (sem cascata destrutiva)
        await queryD1('UPDATE crm_media SET folder_id = NULL WHERE folder_id = ?', [req.params.id]);
        await queryD1('UPDATE crm_media_folders SET parent_id = NULL WHERE parent_id = ?', [req.params.id]);
        await queryD1('DELETE FROM crm_media_folders WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        console.error('Erro ao excluir pasta:', e);
        res.status(500).json({ error: 'Erro ao excluir a pasta.' });
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
    // A Meta devolve o número BR sem o 9º dígito do celular (ex.: "+55 84 8262-1850").
    // Um link wa.me com esse número não abre a conversa — precisa do 9 na frente do
    // local. normalizePhoneBR() insere o 9 e garante o DDI 55.
    cachedClinicWhatsAppNumber = normalizePhoneBR(json.display_phone_number);
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

// Relatório de anúncios Meta (Click-to-WhatsApp): agrupa por "origem" (que já
// vem como "Meta Ads: <título do anúncio>" desde o webhook) todo lead que tem
// ctwa_clid — ou seja, veio de um clique real rastreado, não de mensagem
// orgânica. 1 SELECT agregado só, nada de N+1 por anúncio.
app.get('/api/meta-ads/report', async (req, res) => {
    try {
        const rows = await queryD1(`
            SELECT
                origem,
                COUNT(*) as leads,
                SUM(CASE WHEN column_id = 'col-agendado' THEN 1 ELSE 0 END) as agendados,
                SUM(CASE WHEN column_id = 'col-ganho' THEN 1 ELSE 0 END) as ganhos,
                COALESCE(SUM(CASE WHEN column_id IN ('col-ganho','col-agendado') THEN valor_recebido ELSE 0 END), 0) as receita,
                SUM(capi_lead_sent) as capi_lead_ok,
                SUM(capi_schedule_sent) as capi_schedule_ok,
                SUM(capi_purchase_sent) as capi_purchase_ok
            FROM leads
            WHERE ctwa_clid IS NOT NULL AND ctwa_clid != ''
            GROUP BY origem
            ORDER BY leads DESC
        `);
        res.json({ anuncios: rows || [] });
    } catch (e) {
        console.error('Erro no relatório de anúncios Meta:', e);
        res.status(500).json({ error: 'Erro interno.' });
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
                id TEXT PRIMARY KEY,
                shortcut TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
        // Data em que o valor (orçamento/venda) passou a existir — o dashboard usa essa
        // data pra filtrar receita por período, não o created_at (que é de quando o lead
        // entrou no CRM, podendo ser bem antes do valor ter sido definido).
        try { await queryD1('ALTER TABLE leads ADD COLUMN data_valor DATETIME'); } catch(e) {}
        // Proteção anti-bloqueio: lead que optou por não receber disparos de campanha/marketing
        try { await queryD1('ALTER TABLE leads ADD COLUMN campaign_opt_out INTEGER DEFAULT 0'); } catch(e) {}
        try { await queryD1('ALTER TABLE leads ADD COLUMN cpf TEXT'); } catch(e) {}
        try { await queryD1('ALTER TABLE leads ADD COLUMN endereco TEXT'); } catch(e) {}
        // Click-to-WhatsApp: id do clique do anúncio (vem no referral do webhook) + cópia
        // do referral. As flags capi_*_sent garantem que cada evento sai UMA vez por lead.
        try { await queryD1('ALTER TABLE leads ADD COLUMN ctwa_clid TEXT'); } catch(e) {}
        try { await queryD1('ALTER TABLE leads ADD COLUMN ad_referral TEXT'); } catch(e) {}
        try { await queryD1('ALTER TABLE leads ADD COLUMN capi_lead_sent INTEGER DEFAULT 0'); } catch(e) {}
        try { await queryD1('ALTER TABLE leads ADD COLUMN capi_schedule_sent INTEGER DEFAULT 0'); } catch(e) {}
        try { await queryD1('ALTER TABLE leads ADD COLUMN capi_purchase_sent INTEGER DEFAULT 0'); } catch(e) {}

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
                sendPushToAll('CRM', loginMessage).catch(() => {});
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
        const rows = await queryD1('SELECT username, role, display_name FROM crm_users ORDER BY username ASC');
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

app.put('/api/users/:username', async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradores podem editar usuários.' });
    }
    const { username } = req.params;
    const { display_name, role, password } = req.body;

    if (role !== undefined && !['user', 'admin'].includes(role)) {
        return res.status(400).json({ error: 'Cargo inválido.' });
    }
    if (username === 'admin' && role !== undefined && role !== 'admin') {
        return res.status(400).json({ error: 'Não é possível remover o cargo de administrador do usuário principal.' });
    }
    if (display_name !== undefined && String(display_name).length > 80) {
        return res.status(400).json({ error: 'Nome de exibição muito longo (máximo 80 caracteres).' });
    }
    if (password !== undefined && String(password) !== '' && String(password).trim().length < 6) {
        return res.status(400).json({ error: 'A nova senha precisa ter pelo menos 6 caracteres.' });
    }

    try {
        const existing = await queryD1('SELECT username FROM crm_users WHERE username = ?', [username]);
        if (!existing || existing.length === 0) {
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }

        const updates = [];
        const params = [];
        if (display_name !== undefined) { updates.push('display_name = ?'); params.push(String(display_name).trim()); }
        if (role !== undefined) { updates.push('role = ?'); params.push(role); }
        if (password !== undefined && String(password) !== '') {
            const hash = await bcrypt.hash(String(password).trim(), 12);
            updates.push('password = ?'); params.push(hash);
            updates.push('must_change_password = ?'); params.push(1);
        }

        if (updates.length === 0) {
            return res.json({ success: true });
        }

        params.push(username);
        await queryD1(`UPDATE crm_users SET ${updates.join(', ')} WHERE username = ?`, params);
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
        // Poda oportunista: a tabela só era limpa manualmente (/api/clear-notif) e
        // crescia sem limite, então cada poll relia centenas de linhas pra devolver
        // 50. Aqui, ~1 em cada 20 chamadas, remove o que passou de 30 dias.
        if (Math.random() < 0.05) {
            queryD1("DELETE FROM crm_notifications WHERE created_at < datetime('now', '-30 days')").catch(() => {});
        }
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

// ==== KANBAN SSE (Server-Sent Events para sincronização em tempo real) ====

const sseClients = new Set();

function broadcastLeadsUpdate(action = 'updated', leadId = null, extra = null) {
    const payload = `data: ${JSON.stringify(Object.assign({ action, leadId, ts: Date.now() }, extra || {}))}\n\n`;
    for (const client of sseClients) {
        try { client.write(payload); } catch (_) { sseClients.delete(client); }
    }
}

app.get('/api/kanban/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    res.write(': connected\n\n');
    sseClients.add(res);

    const keepAlive = setInterval(() => {
        try { res.write(': ping\n\n'); } catch (_) {}
    }, 25000);

    req.on('close', () => {
        clearInterval(keepAlive);
        sseClients.delete(res);
    });
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
// META CAPI — feedback de conversão pro Meta Ads
// Para leads de Click-to-WhatsApp o segredo é: action_source 'business_messaging'
// + messaging_channel 'whatsapp' + o ctwa_clid CRU (nunca hasheado).
// ==========================================
const META_GRAPH = process.env.META_GRAPH_VERSION || 'v21.0';

// As colunas da CAPI ficam num ALTER TABLE lá no boot, que na Vercel serverless
// nem sempre chega a rodar (a função é congelada antes). Aqui a gente garante
// que existem, de forma preguiçosa, na primeira vez que qualquer caminho precisa
// delas — webhook (INSERT de lead novo) e fireCapiForLead (SELECT).
let _capiColsReady = false;
async function ensureCapiColumns() {
    if (_capiColsReady) return;
    for (const sql of [
        'ALTER TABLE leads ADD COLUMN ctwa_clid TEXT',
        'ALTER TABLE leads ADD COLUMN ad_referral TEXT',
        'ALTER TABLE leads ADD COLUMN capi_lead_sent INTEGER DEFAULT 0',
        'ALTER TABLE leads ADD COLUMN capi_schedule_sent INTEGER DEFAULT 0',
        'ALTER TABLE leads ADD COLUMN capi_purchase_sent INTEGER DEFAULT 0'
    ]) {
        try { await queryD1(sql, []); } catch (e) { /* já existe */ }
    }
    _capiColsReady = true;
}

// Valor de compra do lead em BRL (reais) pro custom_data.value do Purchase.
function leadPurchaseValueBRL(lead) {
    const rec = brlToCents(lead && lead.valor_recebido);
    if (rec && rec > 0) return rec / 100;
    const soma = parseOrcamentoArray(lead && lead.orcamento)
        .reduce((s, it) => s + (brlToCents(it.valor) || 0), 0);
    return soma > 0 ? soma / 100 : null;
}

// Envia UM evento pro Conversions API. Retorna { ok, ... } e nunca lança.
async function sendMetaCapiEvent(eventName, {
    telefone, email, nome, externalId, ctwa_clid, eventId, eventTimeSec, value, currency = 'BRL'
} = {}) {
    // .trim() defensivo: colar env var na Vercel costuma deixar \n / espaço no fim.
    const siteDatasetId = (process.env.META_CAPI_DATASET_ID || process.env.META_PIXEL_ID || '').trim();
    const token     = (process.env.META_CAPI_TOKEN     || process.env.META_ACCESS_TOKEN || '').trim();
    const testCode  = (process.env.META_CAPI_TEST_EVENT_CODE || '').trim();
    const wabaId    = (process.env.META_CAPI_WABA_ID || process.env.META_WABA_ID || '').trim();
    // Eventos de Click-to-WhatsApp (com ctwa_clid) precisam ir pro dataset que
    // PERTENCE à conta do WhatsApp Business — não pro dataset do site (subcode 2804132).
    // Esse dataset foi criado via POST /{WABA}/dataset, então quem tem acesso é o
    // token do WhatsApp (system user da WABA), não o token do CAPI do site.
    const wabaDatasetId = (process.env.META_CAPI_WABA_DATASET_ID || '').trim();
    const useWaba = (!!ctwa_clid && wabaDatasetId);
    const datasetId = useWaba ? wabaDatasetId : siteDatasetId;
    const sendToken = useWaba
        ? ((process.env.META_CAPI_WABA_TOKEN || process.env.META_WA_ACCESS_TOKEN || token).trim())
        : token;
    if (!datasetId || !sendToken) {
        console.warn(`CAPI ${eventName} PULADO: falta ${!datasetId ? 'dataset id' : 'token'} no ambiente`);
        return { ok: false, skipped: true };
    }
    console.log(`CAPI ${eventName}: enviando pro dataset ${datasetId} (${META_GRAPH})${ctwa_clid ? ' com ctwa_clid' : ''}`);

    const sha = (v) => v
        ? crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex')
        : undefined;

    const phone = (telefone || '').replace(/\D/g, '');   // 5561999999999
    const isMsg = !!ctwa_clid;

    // nome completo -> fn / ln (tira sufixo [MKT] do CRM, colapsa espaços)
    const nomeLimpo = String(nome || '').replace(/\[mkt\]/ig, '').replace(/\s+/g, ' ').trim();
    const nomePartes = nomeLimpo ? nomeLimpo.split(' ') : [];
    const fn = nomePartes[0] || '';
    const ln = nomePartes.length > 1 ? nomePartes.slice(1).join(' ') : '';

    // Pra action_source 'business_messaging' (Click-to-WhatsApp) o Meta só aceita
    // um punhado de event_name. Testado: 'Lead', 'Schedule', 'CompleteRegistration',
    // 'SubmitApplication' -> todos recusados (error_subcode 2804066). Válidos: só
    // 'LeadSubmitted' e 'Purchase'. Então:
    //   Lead     -> LeadSubmitted
    //   Purchase -> Purchase
    //   Schedule -> não tem equivalente CTWA; não envia (fica métrica só no CRM)
    const MSG_EVENT_MAP = { Lead: 'LeadSubmitted' };
    const MSG_EVENT_UNSUPPORTED = new Set(['Schedule']);
    if (isMsg && MSG_EVENT_UNSUPPORTED.has(eventName)) {
        console.log(`CAPI ${eventName}: sem nome válido pra business_messaging (CTWA) — não enviado`);
        return { ok: false, unsupportedForCtwa: true };
    }
    const finalEventName = isMsg ? (MSG_EVENT_MAP[eventName] || eventName) : eventName;
    if (isMsg && !wabaId) {
        console.warn(`CAPI ${eventName}: business_messaging sem META_WABA_ID — o Meta vai recusar (2804116)`);
    }

    // event_time: nunca no futuro, nunca > ~7 dias atrás (janela do CTWA).
    const now = Math.floor(Date.now() / 1000);
    const t = Math.min(now, Math.max(eventTimeSec || now, now - 6 * 86400));

    const evt = {
        event_name: finalEventName,                   // Lead->LeadSubmitted (msg) | Schedule | Purchase
        event_time: t,
        event_id: eventId || `${eventName}:${phone}`,   // dedup
        action_source: isMsg ? 'business_messaging' : 'system_generated',
        messaging_channel: isMsg ? 'whatsapp' : undefined,
        user_data: {
            ph: phone ? [sha(phone)] : undefined,
            em: email ? [sha(email)] : undefined,
            fn: fn ? [sha(fn)] : undefined,
            ln: ln ? [sha(ln)] : undefined,
            external_id: externalId ? [sha(String(externalId))] : undefined,
            ctwa_clid: ctwa_clid || undefined,          // CRU, sem hash
            // business_messaging exige page_id OU whatsapp_business_account_id (subcode 2804116)
            whatsapp_business_account_id: isMsg ? (wabaId || undefined) : undefined
        }
    };
    if (eventName === 'Purchase' && value != null) {
        evt.custom_data = { value: Number(value), currency };
    }

    const body = { data: [evt] };
    if (testCode) body.test_event_code = testCode;

    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 4000);
    try {
        const r = await fetch(`https://graph.facebook.com/${META_GRAPH}/${datasetId}/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, access_token: sendToken }),
            signal: ac.signal
        });
        const j = await r.json();
        if (!r.ok) {
            console.error(`CAPI ${eventName} falhou:`, j.error?.message, 'fbtrace:', j.error?.fbtrace_id);
            return { ok: false, error: j.error };
        }
        console.log(`CAPI ${eventName} ok (events_received: ${j.events_received})`);
        return { ok: true, result: j };
    } catch (e) {
        console.error(`CAPI ${eventName} exceção:`, e.message);
        return { ok: false, error: { message: e.message, name: e.name } };
    } finally {
        clearTimeout(to);
    }
}

// Dispara um evento CAPI pra um lead UMA vez só (flag capi_<evento>_sent na tabela).
async function fireCapiForLead(leadId, eventName, extra = {}) {
    if (!leadId) return;
    await ensureCapiColumns();
    const col = `capi_${eventName.toLowerCase()}_sent`;
    let lead;
    try {
        const rows = await queryD1(
            `SELECT telefone, email, nome, ctwa_clid, valor_recebido, orcamento, ${col} AS sent FROM leads WHERE id = ?`,
            [leadId]
        );
        lead = rows && rows[0];
    } catch (e) {
        console.error(`CAPI ${eventName}: SELECT do lead ${leadId} falhou (as colunas capi_*/ctwa_clid existem?):`, e.message);
        return;
    }
    if (!lead) { console.warn(`CAPI ${eventName}: lead ${leadId} não encontrado`); return { ok: false, reason: 'lead-nao-encontrado' }; }
    if (lead.sent) { console.log(`CAPI ${eventName}: já enviado antes pro lead ${leadId}, pulando`); return { ok: false, reason: 'ja-enviado' }; }

    if (eventName === 'Purchase' && extra.value == null) {
        const v = leadPurchaseValueBRL(lead);
        if (v != null) extra = { ...extra, value: v };
    }

    const res = await sendMetaCapiEvent(eventName, {
        telefone: lead.telefone,
        email: lead.email,
        nome: lead.nome,
        externalId: leadId,
        ctwa_clid: lead.ctwa_clid,
        eventId: `${eventName}:${leadId}`,
        ...extra
    });
    // res.ok = enviado. res.unsupportedForCtwa = o Meta não tem esse evento pra
    // CTWA — marca como "resolvido" mesmo assim, senão todo arrasto de coluna
    // tenta reenviar pra sempre.
    if (res.ok || res.unsupportedForCtwa) {
        try { await queryD1(`UPDATE leads SET ${col} = 1 WHERE id = ?`, [leadId]); } catch (e) {}
    }
    return res;
}

// Autodiagnóstico da CAPI — abra /api/capi-selftest logado como admin.
// ?send=1 dispara um evento Lead de teste de verdade e devolve a resposta do Meta.
app.get('/api/capi-selftest', async (req, res) => {
    if (!(req.user && (req.user.role === 'admin' || req.user.username === 'admin'))) {
        return res.status(403).json({ error: 'Só admin.' });
    }
    const cfg = {
        dataset_id: process.env.META_CAPI_DATASET_ID || process.env.META_PIXEL_ID || null,
        dataset_source: process.env.META_CAPI_DATASET_ID ? 'META_CAPI_DATASET_ID'
            : (process.env.META_PIXEL_ID ? 'META_PIXEL_ID (fallback)' : null),
        token_configurado: !!(process.env.META_CAPI_TOKEN || process.env.META_ACCESS_TOKEN),
        token_source: process.env.META_CAPI_TOKEN ? 'META_CAPI_TOKEN'
            : (process.env.META_ACCESS_TOKEN ? 'META_ACCESS_TOKEN (fallback)' : null),
        graph_version: META_GRAPH,
        test_event_code: (process.env.META_CAPI_TEST_EVENT_CODE || '').trim() || null,
        test_event_code_raw_len: (process.env.META_CAPI_TEST_EVENT_CODE || '').length,
        waba_id: (process.env.META_CAPI_WABA_ID || process.env.META_WABA_ID || '').trim() || null,
        waba_id_source: process.env.META_CAPI_WABA_ID ? 'META_CAPI_WABA_ID'
            : (process.env.META_WABA_ID ? 'META_WABA_ID' : null),
        waba_dataset_id: (process.env.META_CAPI_WABA_DATASET_ID || '').trim() || null
    };
    // Checa se as colunas novas existem na tabela leads (o caminho do arrasto depende delas).
    await ensureCapiColumns(); // cria as colunas se faltarem — só de abrir esse endpoint já conserta
    let colunas_leads;
    try {
        await queryD1('SELECT ctwa_clid, capi_lead_sent, capi_schedule_sent, capi_purchase_sent FROM leads LIMIT 1', []);
        colunas_leads = 'ok — ctwa_clid / capi_lead_sent / capi_schedule_sent / capi_purchase_sent existem';
    } catch (e) {
        colunas_leads = 'FALTAM: ' + e.message + ' — o ALTER TABLE do boot não rodou nesse deploy';
    }

    // ?waba_info=1 — de qual Business Manager são a WABA e o dataset de CTWA,
    // e o que a API sabe do dataset (nome, contagem de eventos recentes).
    if (req.query.waba_info) {
        const wabaId  = (process.env.META_CAPI_WABA_ID || process.env.META_WABA_ID || '').trim();
        const dsId    = (process.env.META_CAPI_WABA_DATASET_ID || '').trim();
        const waTok   = (process.env.META_WA_ACCESS_TOKEN || process.env.META_CAPI_TOKEN || process.env.META_ACCESS_TOKEN || '').trim();
        if (!wabaId || !waTok) return res.json({ cfg, colunas_leads, waba_info: { erro: 'falta META_WABA_ID ou token' } });
        const g = (url) => fetch(`https://graph.facebook.com/${META_GRAPH}/${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(waTok)}`).then(r => r.json()).catch(e => ({ error: { message: e.message } }));
        const [waba, dataset, dsStats] = await Promise.all([
            g(`${wabaId}?fields=id,name,owner_business_info,on_behalf_of_business_info`),
            dsId ? g(`${dsId}?fields=id,name,owner_business`) : Promise.resolve({ skipped: 'sem META_CAPI_WABA_DATASET_ID' }),
            dsId ? g(`${dsId}/stats?fields=count,event_name&start_time=${Math.floor(Date.now()/1000) - 3*86400}`) : Promise.resolve(null)
        ]);
        return res.json({ cfg, colunas_leads, waba_info: {
            business_id_da_url: req.query.business_id || null,
            waba, dataset, dataset_stats_3d: dsStats
        } });
    }

    // ?waba_check=1 — confere se o número da Cloud API (META_WA_PHONE_ID) está
    // mesmo dentro da WABA (META_WABA_ID) usada no CAPI.
    if (req.query.waba_check) {
        const wabaId   = (process.env.META_CAPI_WABA_ID || process.env.META_WABA_ID || '').trim();
        const phoneId  = (process.env.META_WA_PHONE_ID || '').trim();
        const waTok    = (process.env.META_WA_ACCESS_TOKEN || process.env.META_CAPI_TOKEN || process.env.META_ACCESS_TOKEN || '').trim();
        if (!wabaId || !phoneId || !waTok) {
            return res.json({ cfg, colunas_leads, waba_check: { erro: 'falta META_WABA_ID, META_WA_PHONE_ID ou token' } });
        }
        try {
            const nums = await fetch(`https://graph.facebook.com/${META_GRAPH}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating&access_token=${encodeURIComponent(waTok)}`).then(r => r.json()).catch(() => ({}));
            const lista = (nums && nums.data) || [];
            const bate = lista.some(n => String(n.id) === phoneId);
            return res.json({ cfg, colunas_leads, waba_check: {
                waba_id: wabaId,
                meta_wa_phone_id: phoneId,
                numero_esta_na_waba: bate,
                numeros_da_waba: lista,
                erro_api: nums && nums.error || null
            } });
        } catch (e) {
            return res.json({ cfg, colunas_leads, waba_check: { erro: e.message } });
        }
    }

    // ?waba_dataset=1 — cria/recupera o dataset que PERTENCE à conta do WhatsApp
    // Business (obrigatório pra eventos de Click-to-WhatsApp, subcode 2804132).
    // Devolve o id do dataset — é ele que deve ir na env META_CAPI_WABA_DATASET_ID.
    if (req.query.waba_dataset) {
        const wabaId = (process.env.META_CAPI_WABA_ID || process.env.META_WABA_ID || '').trim();
        const waTok  = (process.env.META_WA_ACCESS_TOKEN || process.env.META_CAPI_TOKEN || process.env.META_ACCESS_TOKEN || '').trim();
        if (!wabaId || !waTok) {
            return res.json({ cfg, colunas_leads, waba_dataset: { erro: 'falta META_WABA_ID ou META_WA_ACCESS_TOKEN no ambiente' } });
        }
        try {
            // GET primeiro — se já existe, o Meta devolve o(s) dataset(s) da WABA.
            const g = await fetch(`https://graph.facebook.com/${META_GRAPH}/${wabaId}/dataset?access_token=${encodeURIComponent(waTok)}`);
            const gj = await g.json().catch(() => ({}));
            let created = null;
            if (!gj || !gj.data || !gj.data.length) {
                const p = await fetch(`https://graph.facebook.com/${META_GRAPH}/${wabaId}/dataset`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ access_token: waTok })
                });
                created = await p.json().catch(() => ({}));
            }
            return res.json({ cfg, colunas_leads, waba_dataset: {
                waba_id: wabaId,
                existentes: (gj && gj.data) || gj || null,
                criado: created,
                dica: 'Pegue o id retornado e ponha em META_CAPI_WABA_DATASET_ID no Vercel. Os eventos de CTWA passam a ir pra esse dataset.'
            } });
        } catch (e) {
            return res.json({ cfg, colunas_leads, waba_dataset: { erro: e.message } });
        }
    }

    // ?probe=<EventName>&lead=<id> — dispara UM evento com o nome cru fornecido
    // (usando o ctwa_clid do lead, então vai como business_messaging). Não grava
    // flag nenhuma. Serve pra descobrir quais event_name o Meta aceita p/ CTWA.
    if (req.query.probe) {
        const nome = String(req.query.probe).slice(0, 40);
        let lr = null;
        if (req.query.lead) {
            lr = await queryD1('SELECT id, telefone, email, nome, ctwa_clid FROM leads WHERE id = ?', [String(req.query.lead)]).catch(() => null);
        }
        if (!lr || !lr[0]) {
            // fallback: pega o lead mais recente que tenha ctwa_clid
            lr = await queryD1("SELECT id, telefone, email, nome, ctwa_clid FROM leads WHERE ctwa_clid IS NOT NULL AND ctwa_clid != '' ORDER BY created_at DESC LIMIT 1", []).catch(() => null);
        }
        const ld = lr && lr[0];
        if (!ld) return res.json({ cfg, colunas_leads, probe: { erro: 'nenhum lead com ctwa_clid encontrado — passe &lead=<id>' } });
        const r = await sendMetaCapiEvent(nome, {
            telefone: ld.telefone, email: ld.email, nome: ld.nome, externalId: ld.id, ctwa_clid: ld.ctwa_clid,
            eventId: `probe:${nome}:${ld.id}:${Date.now()}`
        });
        return res.json({ cfg, colunas_leads, probe: { event_name: nome, lead_id: ld.id, tinha_ctwa_clid: !!ld.ctwa_clid, resposta_meta: r } });
    }

    // ?fire=<leadId>&event=Schedule|Purchase|Lead — roda o caminho EXATO do arrasto num lead real.
    if (req.query.fire) {
        const ev = ['Schedule', 'Purchase', 'Lead'].includes(req.query.event) ? req.query.event : 'Schedule';
        const before = await queryD1(`SELECT id, column_id, ctwa_clid, capi_${ev.toLowerCase()}_sent AS flag FROM leads WHERE id = ?`, [String(req.query.fire)]).catch(() => null);
        const r = await fireCapiForLead(String(req.query.fire), ev);
        const after = await queryD1(`SELECT capi_${ev.toLowerCase()}_sent AS flag FROM leads WHERE id = ?`, [String(req.query.fire)]).catch(() => null);
        return res.json({ cfg, colunas_leads, fire: { evento: ev, lead_antes: before && before[0], flag_depois: after && after[0], resposta_meta: r } });
    }

    // ?fire_pendentes=lead|schedule|purchase — dispara o evento pra TODOS os leads
    // pendentes (flag 0) dos últimos 7 dias que fazem sentido pro evento.
    if (req.query.fire_pendentes) {
        const ev = ['Lead', 'Schedule', 'Purchase'].find(e => e.toLowerCase() === String(req.query.fire_pendentes).toLowerCase());
        if (!ev) return res.status(400).json({ error: 'fire_pendentes deve ser lead, schedule ou purchase' });
        const flagCol = `capi_${ev.toLowerCase()}_sent`;
        let where = `${flagCol} = 0 AND created_at > datetime('now', '-7 days')`;
        if (ev === 'Lead')     where += ` AND ctwa_clid IS NOT NULL AND ctwa_clid != ''`;
        if (ev === 'Schedule') where += ` AND column_id = 'col-agendado'`;
        if (ev === 'Purchase') where += ` AND column_id = 'col-ganho'`;
        const pend = await queryD1(`SELECT id, telefone, ctwa_clid FROM leads WHERE ${where} ORDER BY created_at DESC LIMIT 200`, []).catch(() => []);
        const linhas = pend || [];
        let enviados = 0, falharam = 0, primeiroErro = null, primeiroErroLead = null;
        for (const linha of linhas) {
            const r = await fireCapiForLead(linha.id, ev);
            if (r && r.ok) { enviados++; }
            else {
                falharam++;
                if (!primeiroErro) {
                    // objeto de erro COMPLETO do Meta (message, code, error_subcode,
                    // error_user_title, error_user_msg, fbtrace_id) — é o que revela
                    // qual parâmetro o Meta está recusando.
                    primeiroErro = (r && (r.error || r.reason)) || 'sem detalhe';
                    primeiroErroLead = {
                        lead_id: linha.id,
                        telefone_len: (linha.telefone || '').replace(/\D/g, '').length,
                        ctwa_clid_len: (linha.ctwa_clid || '').length,
                        ctwa_clid_preview: (linha.ctwa_clid || '').slice(0, 12)
                    };
                }
            }
        }
        return res.json({ cfg, colunas_leads, fire_pendentes: { evento: ev, encontrados: linhas.length, enviados, falharam, primeiro_erro: primeiroErro, primeiro_erro_lead: primeiroErroLead } });
    }

    if (req.query.send !== '1') {
        return res.json({ cfg, colunas_leads, dica: '?send=1 dispara um Lead de teste. ?fire=<leadId>&event=Schedule roda o caminho do arrasto num lead real.' });
    }
    const r = await sendMetaCapiEvent('Lead', {
        telefone: '5561999990000',
        eventId: `selftest:${Date.now()}`
    });
    res.json({ cfg, colunas_leads, envio: r });
});

// Por que a IA não está respondendo esse lead?
// /api/ai-selftest?phone=5561999999999   (ou ?lead=<id>)
app.get('/api/ai-selftest', async (req, res) => {
    if (!(req.user && (req.user.role === 'admin' || req.user.username === 'admin'))) {
        return res.status(403).json({ error: 'Só admin.' });
    }
    try {
        const AI_COLS = ['col-entrada', 'col-contatado'];
        const out = { checks: {}, bloqueios: [] };

        const globalRow = await queryD1("SELECT value FROM crm_settings WHERE key = 'whatsapp_ai_enabled'");
        const globalEnabled = globalRow && globalRow[0] ? globalRow[0].value === '1' : true;
        out.checks.ia_global_ligada = globalEnabled;
        if (!globalEnabled) out.bloqueios.push('IA global desligada (Configurações da IA).');

        out.checks.gemini_key_configurada = !!(process.env.GEMINI_API_KEY || '').trim();
        if (!out.checks.gemini_key_configurada) out.bloqueios.push('GEMINI_API_KEY não configurada.');

        let lead = null;
        if (req.query.lead) {
            const r = await queryD1('SELECT * FROM leads WHERE id = ?', [String(req.query.lead)]);
            lead = r && r[0];
        } else if (req.query.phone) {
            const variants = phoneVariants(String(req.query.phone));
            const ph = variants.map(() => '?').join(', ');
            const r = await queryD1(`SELECT * FROM leads WHERE telefone IN (${ph}) ORDER BY created_at DESC LIMIT 1`, variants);
            lead = r && r[0];
        } else {
            return res.status(400).json({ error: 'Passe ?phone=<numero> ou ?lead=<id>.' });
        }
        if (!lead) return res.json(Object.assign(out, { erro: 'Lead não encontrado pra esse telefone/id.' }));

        out.lead = { id: lead.id, nome: lead.nome, telefone: lead.telefone, column_id: lead.column_id, ai_enabled: lead.ai_enabled, owner_id: lead.owner_id, tags: lead.tags };

        out.checks.lead_ai_enabled = Number(lead.ai_enabled) === 1;
        if (!out.checks.lead_ai_enabled) out.bloqueios.push('ai_enabled do lead é 0 — alguém mandou mensagem manual, ou a IA já qualificou/entregou. Religue no painel do lead ou use "Transferir para a IA".');

        out.checks.coluna_atendida_pela_ia = AI_COLS.includes(lead.column_id);
        if (!out.checks.coluna_atendida_pela_ia) out.bloqueios.push(`Lead está em "${lead.column_id}" — a IA só responde em ${AI_COLS.join(' ou ')}.`);

        const parsedTags = lead.tags ? String(lead.tags).split(',').map(s => s.trim()).filter(Boolean) : [];
        out.checks.tem_tag_ia_qualificado = parsedTags.includes('ia-qualificado');
        if (out.checks.tem_tag_ia_qualificado) out.bloqueios.push('Lead tem a tag "ia-qualificado" — a IA já entregou pra equipe. Remova a tag (ou use "Transferir para a IA") pra ela voltar.');

        const variants = phoneVariants(lead.telefone || '');
        const ph = variants.map(() => '?').join(', ');

        const flowRuns = await queryD1(
            `SELECT id, flow_id, status, current_node_id, updated_at FROM crm_flow_runs WHERE phone IN (${ph}) AND status IN ('running','waiting_reply','sleeping') ORDER BY updated_at DESC`,
            variants
        ).catch(() => []);
        out.checks.fluxos_ativos = flowRuns || [];
        if ((flowRuns || []).some(r => r.status === 'waiting_reply')) {
            out.bloqueios.push('Há um fluxo em "waiting_reply" pra esse número — o motor de fluxo intercepta a mensagem e a IA não responde. Encerre o fluxo ou use "Transferir para a IA" (que já encerra os fluxos).');
        }

        const lastMsg = await queryD1(
            `SELECT direction, message, timestamp FROM wa_messages WHERE phone IN (${ph}) ORDER BY timestamp DESC LIMIT 1`,
            variants
        ).catch(() => []);
        out.checks.ultima_mensagem = lastMsg && lastMsg[0] ? { direcao: lastMsg[0].direction, quando: lastMsg[0].timestamp, previa: String(lastMsg[0].message || '').slice(0, 80) } : null;
        if (lastMsg && lastMsg[0] && lastMsg[0].direction === 'out') {
            out.bloqueios.push('A última mensagem foi nossa (out) — a IA só é acionada quando CHEGA uma mensagem nova do lead. Ela responde no próximo "oi" dele.');
        }

        out.veredito = out.bloqueios.length === 0
            ? 'Nenhum bloqueio encontrado — a IA deve responder a próxima mensagem do lead. Se ainda não responder, veja os logs do deploy (erro no Gemini / timeout).'
            : `${out.bloqueios.length} bloqueio(s) — resolva os itens acima.`;

        res.json(out);
    } catch (e) {
        console.error('ai-selftest erro:', e);
        res.status(500).json({ error: 'Erro interno.', detalhe: e.message });
    }
});

// ==========================================
// META MARKETING API — gasto de anúncio + ROI por campanha
// Complemento da CAPI: a CAPI manda "virou consulta" PRO Meta; aqui a gente puxa
// DO Meta quanto cada campanha gastou, cruza com os leads atribuídos (ad_referral
// .source_id, gravado pelo webhook de Click-to-WhatsApp) e o estágio do Kanban
// pra chegar em custo por lead / por consulta / ROAS.
//
// Single-tenant: a conta de anúncio e o token vêm do .env. Quando virar
// multi-clínica, isso migra pra um token por clinic_id cifrado no D1.
//   META_ADS_ACCOUNT_ID  -> id da conta (com ou sem o prefixo act_)
//   META_ADS_TOKEN       -> token long-lived com ads_read (cai pra META_API_MARKETING
//                           e depois META_ACCESS_TOKEN se não existir)
// ==========================================
function metaAdsConfig() {
    const token = (process.env.META_ADS_TOKEN || process.env.META_API_MARKETING || process.env.META_ACCESS_TOKEN || '').trim();
    const acct  = (process.env.META_ADS_ACCOUNT_ID || '').trim().replace(/^act_/, '');
    const appSecret = (process.env.META_APP_SECRET || '').trim();
    return { token, acct, appSecret, ok: !!(token && acct) };
}

let _adTablesReady = false;
async function ensureAdTables() {
    if (_adTablesReady) return;
    for (const sql of [
        `CREATE TABLE IF NOT EXISTS ad_campaigns (
            id TEXT PRIMARY KEY, name TEXT, status TEXT, objective TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS ad_ads (
            id TEXT PRIMARY KEY, campaign_id TEXT, name TEXT, status TEXT,
            creative_body TEXT, thumbnail_url TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS ad_insights_daily (
            date TEXT NOT NULL, ad_id TEXT NOT NULL, adset_id TEXT, campaign_id TEXT,
            spend REAL DEFAULT 0, impressions INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0,
            reach INTEGER DEFAULT 0, msg_started INTEGER DEFAULT 0, leads_form INTEGER DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (date, ad_id)
        )`
    ]) {
        try { await queryD1(sql, []); } catch (e) { console.error('[marketing] ensureAdTables:', e.message); }
    }
    _adTablesReady = true;
}

// GET no Graph seguindo paginação (paging.next). Devolve todos os data[] juntos.
async function metaGraphGetAll(path, params, cfg) {
    const { token, appSecret } = cfg;
    const proof = appSecret ? crypto.createHmac('sha256', appSecret).update(token).digest('hex') : null;
    let url = new URL(`https://graph.facebook.com/${META_GRAPH}/${path}`);
    url.searchParams.set('access_token', token);
    if (proof) url.searchParams.set('appsecret_proof', proof);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);

    const out = [];
    let next = url.toString();
    let guard = 0;
    while (next && guard++ < 25) {
        const r = await fetch(next);
        const j = await r.json();
        if (j.error) throw new Error(`Graph ${path}: ${j.error.message} (code ${j.error.code}${j.error.error_subcode ? '/' + j.error.error_subcode : ''})`);
        if (Array.isArray(j.data)) out.push(...j.data);
        next = j.paging && j.paging.next ? j.paging.next : null;
    }
    return out;
}

function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function _actionVal(actions, type) {
    if (!Array.isArray(actions)) return 0;
    const hit = actions.find(a => a.action_type === type);
    return hit ? Math.round(_num(hit.value)) : 0;
}

// Puxa campanhas + anúncios + insights diários dos últimos `days` dias e grava no D1.
async function syncMetaMarketing({ days = 3 } = {}) {
    const cfg = metaAdsConfig();
    if (!cfg.ok) {
        return { skipped: true, reason: 'META_ADS_ACCOUNT_ID / token ausentes no .env' };
    }
    await ensureAdTables();
    const acct = `act_${cfg.acct}`;
    const started = Date.now();

    // --- campanhas ---
    const campaigns = await metaGraphGetAll(`${acct}/campaigns`, {
        fields: 'id,name,status,objective', limit: '200'
    }, cfg);
    for (let i = 0; i < campaigns.length; i += 20) {
        const ch = campaigns.slice(i, i + 20);
        const ph = ch.map(() => '(?,?,?,?,CURRENT_TIMESTAMP)').join(',');
        const params = ch.flatMap(c => [c.id, c.name || '', c.status || '', c.objective || '']);
        await queryD1(`INSERT OR REPLACE INTO ad_campaigns (id,name,status,objective,updated_at) VALUES ${ph}`, params);
    }

    // --- anúncios (com criativo, pra alimentar o contexto de anúncio da IA) ---
    const ads = await metaGraphGetAll(`${acct}/ads`, {
        fields: 'id,name,status,campaign_id,creative{body,thumbnail_url}', limit: '200'
    }, cfg);
    for (let i = 0; i < ads.length; i += 12) {
        const ch = ads.slice(i, i + 12);
        const ph = ch.map(() => '(?,?,?,?,?,?,CURRENT_TIMESTAMP)').join(',');
        const params = ch.flatMap(a => [
            a.id, a.campaign_id || '', a.name || '', a.status || '',
            (a.creative && a.creative.body) || '', (a.creative && a.creative.thumbnail_url) || ''
        ]);
        await queryD1(`INSERT OR REPLACE INTO ad_ads (id,campaign_id,name,status,creative_body,thumbnail_url,updated_at) VALUES ${ph}`, params);
    }

    // --- insights diários por anúncio ---
    const until = new Date();
    const since = new Date(Date.now() - Math.max(1, days) * 86400 * 1000);
    const fmt = d => d.toISOString().slice(0, 10);
    const insights = await metaGraphGetAll(`${acct}/insights`, {
        level: 'ad',
        time_increment: '1',
        time_range: JSON.stringify({ since: fmt(since), until: fmt(until) }),
        fields: 'ad_id,adset_id,campaign_id,spend,impressions,clicks,reach,actions',
        limit: '500'
    }, cfg);

    const rows = insights.map(r => ({
        date: r.date_start,
        ad_id: r.ad_id,
        adset_id: r.adset_id || '',
        campaign_id: r.campaign_id || '',
        spend: _num(r.spend),
        impressions: Math.round(_num(r.impressions)),
        clicks: Math.round(_num(r.clicks)),
        reach: Math.round(_num(r.reach)),
        msg_started: _actionVal(r.actions, 'onsite_conversion.messaging_conversation_started_7d')
            || _actionVal(r.actions, 'onsite_conversion.total_messaging_connection'),
        leads_form: _actionVal(r.actions, 'lead') || _actionVal(r.actions, 'onsite_conversion.lead_grouped')
    })).filter(r => r.date && r.ad_id);

    for (let i = 0; i < rows.length; i += 9) {
        const ch = rows.slice(i, i + 9);
        const ph = ch.map(() => '(?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)').join(',');
        const params = ch.flatMap(r => [r.date, r.ad_id, r.adset_id, r.campaign_id, r.spend, r.impressions, r.clicks, r.reach, r.msg_started, r.leads_form]);
        await queryD1(`INSERT OR REPLACE INTO ad_insights_daily (date,ad_id,adset_id,campaign_id,spend,impressions,clicks,reach,msg_started,leads_form,updated_at) VALUES ${ph}`, params);
    }

    const summary = { campaigns: campaigns.length, ads: ads.length, insight_rows: rows.length, days, ms: Date.now() - started };
    try {
        await queryD1(
            "INSERT INTO crm_settings (key, value) VALUES ('marketing_sync_last_run', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [JSON.stringify({ at: new Date().toISOString(), ...summary })]
        );
    } catch (e) {}
    console.log(`[marketing] sync ok: ${summary.campaigns} campanhas, ${summary.ads} anúncios, ${summary.insight_rows} linhas de insight (${summary.ms}ms)`);
    return { ok: true, ...summary };
}

// Cadência própria: chamado de graça em todo /api/flow-tick, mas só sincroniza
// de verdade a cada MARKETING_SYNC_HORAS (default 6).
let _mktSyncRunning = false;
async function marketingSyncTick() {
    if (_mktSyncRunning) return { skipped: 'em andamento' };
    if (!metaAdsConfig().ok) return { skipped: 'sem config' };
    const everyH = Number(process.env.MARKETING_SYNC_HORAS) || 6;
    try {
        const r = await queryD1("SELECT value FROM crm_settings WHERE key = 'marketing_sync_last_run'");
        const last = r && r[0] ? JSON.parse(r[0].value || '{}').at : null;
        if (last && (Date.now() - new Date(last).getTime()) < everyH * 3600 * 1000) {
            return { skipped: 'dentro da janela' };
        }
    } catch (e) {}
    _mktSyncRunning = true;
    try {
        return await syncMetaMarketing({ days: 3 });
    } catch (e) {
        console.error('[marketing] tick falhou:', e.message);
        return { erro: e.message };
    } finally {
        _mktSyncRunning = false;
    }
}

// Status da integração — o que está configurado e quando rodou o último sync.
app.get('/api/marketing/status', async (req, res) => {
    const cfg = metaAdsConfig();
    let last = null;
    try {
        const r = await queryD1("SELECT value FROM crm_settings WHERE key = 'marketing_sync_last_run'");
        last = r && r[0] ? JSON.parse(r[0].value || 'null') : null;
    } catch (e) {}
    res.json({
        configurado: cfg.ok,
        conta: cfg.acct ? `act_${cfg.acct}` : null,
        token_source: process.env.META_ADS_TOKEN ? 'META_ADS_TOKEN'
            : process.env.META_API_MARKETING ? 'META_API_MARKETING'
            : process.env.META_ACCESS_TOKEN ? 'META_ACCESS_TOKEN' : null,
        appsecret_proof: !!cfg.appSecret,
        graph: META_GRAPH,
        ultimo_sync: last
    });
});

// Dispara o sync na hora. ?days=30 pra backfill. Só admin.
app.post('/api/marketing/sync', async (req, res) => {
    if (!(req.user && (req.user.role === 'admin' || req.user.username === 'admin'))) {
        return res.status(403).json({ error: 'Só admin.' });
    }
    try {
        const days = Math.min(Math.max(Number(req.query.days) || 3, 1), 90);
        const out = await syncMetaMarketing({ days });
        res.json(out);
    } catch (e) {
        console.error('[marketing] sync manual:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ROI por campanha: gasto (Meta) x leads atribuídos x estágio do Kanban.
// ?since=YYYY-MM-DD&until=YYYY-MM-DD (default: últimos 30 dias)
app.get('/api/marketing/roi', async (req, res) => {
    try {
        await ensureAdTables();
        const fmt = d => d.toISOString().slice(0, 10);
        const until = (req.query.until || fmt(new Date())).slice(0, 10);
        const since = (req.query.since || fmt(new Date(Date.now() - 30 * 86400 * 1000))).slice(0, 10);

        // gasto por campanha na janela
        const spendRows = await queryD1(
            `SELECT i.campaign_id,
                    COALESCE(c.name, '(campanha ' || i.campaign_id || ')') AS name,
                    SUM(i.spend) AS spend, SUM(i.impressions) AS impressions,
                    SUM(i.clicks) AS clicks, SUM(i.msg_started) AS msg_started
             FROM ad_insights_daily i
             LEFT JOIN ad_campaigns c ON c.id = i.campaign_id
             WHERE i.date BETWEEN ? AND ?
             GROUP BY i.campaign_id`,
            [since, until]
        );

        // mapa ad_id -> campanha, pra atribuir lead pelo source_id do referral
        const adRows = await queryD1('SELECT id, campaign_id FROM ad_ads', []);
        const adToCampaign = new Map(adRows.map(a => [String(a.id), String(a.campaign_id || '')]));

        // leads do período que vieram de anúncio Meta
        const leads = await queryD1(
            `SELECT id, origem, ad_referral, column_id, valor_recebido, orcamento, qualificado_em
             FROM leads
             WHERE date(created_at) BETWEEN ? AND ?
               AND (ad_referral IS NOT NULL OR origem LIKE 'Meta Ads%')`,
            [since, until]
        );

        const UNATTR = '__sem_campanha__';
        const buckets = new Map();
        const bucket = (id, name) => {
            if (!buckets.has(id)) buckets.set(id, {
                campaign_id: id === UNATTR ? null : id, name,
                gasto: 0, impressions: 0, clicks: 0, msg_started: 0,
                leads: 0, qualificados: 0, consultas: 0, ganhos: 0, receita: 0
            });
            return buckets.get(id);
        };

        for (const row of spendRows) {
            const b = bucket(String(row.campaign_id || UNATTR), row.name || 'Meta Ads');
            b.gasto += _num(row.spend);
            b.impressions += _num(row.impressions);
            b.clicks += _num(row.clicks);
            b.msg_started += _num(row.msg_started);
        }

        for (const l of leads) {
            let campId = '';
            try {
                const ref = l.ad_referral ? JSON.parse(l.ad_referral) : null;
                if (ref && ref.source_id) campId = adToCampaign.get(String(ref.source_id)) || '';
            } catch (e) {}
            const key = campId || UNATTR;
            const name = campId
                ? (buckets.get(campId)?.name || `(campanha ${campId})`)
                : 'Meta Ads (não atribuído a campanha)';
            const b = bucket(key, name);
            b.leads += 1;
            if (l.qualificado_em) b.qualificados += 1;
            if (l.column_id === 'col-agendado' || l.column_id === 'col-ganho') b.consultas += 1;
            if (l.column_id === 'col-ganho') {
                b.ganhos += 1;
                const v = leadPurchaseValueBRL(l);
                if (v) b.receita += v;
            }
        }

        const round2 = n => Math.round(n * 100) / 100;
        const campanhas = [...buckets.values()].map(b => ({
            ...b,
            gasto: round2(b.gasto),
            receita: round2(b.receita),
            custo_por_lead: b.leads ? round2(b.gasto / b.leads) : null,
            custo_por_qualificado: b.qualificados ? round2(b.gasto / b.qualificados) : null,
            custo_por_consulta: b.consultas ? round2(b.gasto / b.consultas) : null,
            custo_por_ganho: b.ganhos ? round2(b.gasto / b.ganhos) : null,
            roas: b.gasto ? round2(b.receita / b.gasto) : null
        })).sort((a, b) => b.gasto - a.gasto);

        const t = campanhas.reduce((s, c) => ({
            gasto: s.gasto + c.gasto, receita: s.receita + c.receita,
            msg_started: s.msg_started + (c.msg_started || 0),
            leads: s.leads + c.leads, qualificados: s.qualificados + c.qualificados,
            consultas: s.consultas + c.consultas, ganhos: s.ganhos + c.ganhos
        }), { gasto: 0, receita: 0, msg_started: 0, leads: 0, qualificados: 0, consultas: 0, ganhos: 0 });

        res.json({
            periodo: { since, until },
            totais: {
                ...t, gasto: round2(t.gasto), receita: round2(t.receita),
                custo_por_lead: t.leads ? round2(t.gasto / t.leads) : null,
                custo_por_consulta: t.consultas ? round2(t.gasto / t.consultas) : null,
                roas: t.gasto ? round2(t.receita / t.gasto) : null
            },
            campanhas
        });
    } catch (e) {
        console.error('[marketing] roi:', e.message);
        res.status(500).json({ error: e.message });
    }
});

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
        broadcastLeadsUpdate('created', id);
        if (valor_recebido || orcamento) await syncLeadPagamento(id);
        res.json({ success: true, id });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// Ordem do funil — usada por 'advance_only' pra impedir retrocesso (ver abaixo).
const LEAD_FUNNEL_ORDER = ['col-entrada', 'col-contatado', 'col-orcado', 'col-agendado', 'col-ganho'];

// Atualizar dados de um lead (coluna e/ou notas)
app.put('/api/leads/:id', async (req, res) => {
    const { id } = req.params;
    let { column_id, notas, nome, telefone, born, email, tags, valor_recebido, orcamento, campaign_opt_out, ai_enabled, cpf, endereco, empresa_id, no_auto_assign, advance_only } = req.body;
    try {
        const leadRows = await queryD1('SELECT * FROM leads WHERE id = ?', [id]);
        const lead = leadRows && leadRows.length > 0 ? leadRows[0] : null;

        if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });

        // advance_only: usado pelos gatilhos automáticos (abrir a conversa, mandar
        // mensagem) que só deveriam EMPURRAR o lead pra frente no funil (Entrada ->
        // Contatado). Sem isso, um estado desatualizado no navegador do atendente
        // (corrida entre abas, SSE atrasado) podia rebaixar um lead que já estava em
        // Agendado/Ganho de volta pra Contatado. O servidor decide pela coluna atual
        // no banco, não pelo que o cliente acha que é — nunca deixa retroceder.
        if (advance_only && column_id !== undefined) {
            const curIdx = LEAD_FUNNEL_ORDER.indexOf(lead.column_id);
            const newIdx = LEAD_FUNNEL_ORDER.indexOf(column_id);
            if (curIdx !== -1 && newIdx !== -1 && curIdx >= newIdx) {
                column_id = undefined; // mantém a coluna atual, ignora só essa parte do PUT
            }
        }

        const updates = [];
        const params = [];

        // Auto-assign: se o lead não tem dono e um usuário logado está trabalhando ele
        // (arrastando, editando, orçando). Abrir a conversa manda no_auto_assign=true —
        // só olhar a conversa não é atender, então não vira dono nem entra no ranking.
        let logouAtendimentoIniciado = false;
        if (!lead.owner_id && req.user && req.user.username && !no_auto_assign) {
            updates.push('owner_id = ?');
            params.push(req.user.username);
            updates.push('assigned_at = CURRENT_TIMESTAMP');
            logouAtendimentoIniciado = true;
        }

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
        const valueColumns = ['col-orcado', 'col-agendado', 'col-ganho'];
        if (valor_recebido !== undefined || orcamento !== undefined || (column_id !== undefined && valueColumns.includes(column_id))) {
            updates.push('data_valor = ?');
            params.push(new Date().toISOString().slice(0, 19).replace('T', ' '));
        }
        if (campaign_opt_out !== undefined) {
            updates.push('campaign_opt_out = ?');
            params.push(campaign_opt_out ? 1 : 0);
        }
        if (ai_enabled !== undefined) {
            updates.push('ai_enabled = ?');
            params.push(ai_enabled ? 1 : 0);
        }
        if (cpf !== undefined) {
            updates.push('cpf = ?');
            params.push((cpf || '').trim() || null);
        }
        if (endereco !== undefined) {
            updates.push('endereco = ?');
            params.push((endereco || '').trim() || null);
        }
        if (empresa_id !== undefined) {
            updates.push('empresa_id = ?');
            params.push(empresa_id || null);
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

        // Feedback de conversão pro Meta Ads nas transições reais de funil.
        // fireCapiForLead lê o lead já atualizado, calcula o valor e trava por flag.
        if (column_id && lead && column_id !== lead.column_id) {
            if (column_id === 'col-agendado') {
                await fireCapiForLead(id, 'Schedule').catch(e => console.error('CAPI Schedule:', e.message));
            }
            if (column_id === 'col-ganho') {
                await fireCapiForLead(id, 'Purchase').catch(e => console.error('CAPI Purchase:', e.message));
            }
        }

        // Histórico estruturado: auto-assign = "iniciou atendimento"; mudança de
        // coluna cobre sozinha "abriu/fechou orçamento", "agendou", "fechou venda"
        // — é tudo a mesma transição de etapa vista de ângulos diferentes.
        const actorUser = (req.user && req.user.username) || null;
        if (logouAtendimentoIniciado) {
            logLeadEvent(id, 'atendimento_iniciado', actorUser);
        }
        if (column_id && lead && column_id !== lead.column_id) {
            logLeadEvent(id, 'mudanca_coluna', actorUser, JSON.stringify({ de: lead.column_id, para: column_id }));
        }

        // Carimba a data do pagamento na transição que torna o card "pago"
        // (entrou em Ganho, ou ganhou valor_recebido). O Financeiro usa essa
        // data como pago_em — não a data em que o orçamento foi montado.
        const virouGanho = column_id === 'col-ganho' && lead && lead.column_id !== 'col-ganho';
        const ganhouValor = valor_recebido !== undefined && valor_recebido && (lead && !lead.valor_recebido);
        if (virouGanho || ganhouValor) {
            await queryD1(
                'UPDATE leads SET data_pagamento = COALESCE(data_pagamento, ?) WHERE id = ?',
                [new Date().toISOString().slice(0, 19).replace('T', ' '), id]
            ).catch(() => {});
        }

        // Espelha o estado do card na tela Financeiro. Dispara em QUALQUER
        // mudança de coluna (inclusive sair de Ganho/Agendado -> o espelho
        // volta a pendente ou some), além de valor/orçamento.
        if (valor_recebido !== undefined || orcamento !== undefined || column_id !== undefined) {
            await syncLeadPagamento(id, 'lead-update');
            markLeadPagDirty(id);
        }

        broadcastLeadsUpdate('updated', id);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// ==== ORÇAMENTOS (múltiplos procedimentos por lead) ====
// leads.orcamento passou de "um objeto único" pra "um array de itens" — essa
// função lê qualquer um dos dois formatos, convertendo o antigo (objeto sem
// id, de antes dessa mudança) em uma lista de 1 item só pra exibição/edição,
// sem precisar de uma migração em massa no banco.
function parseOrcamentoArray(raw) {
    if (!raw) return [];
    let parsed;
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return []; }
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
        return [{ id: 'legacy', ...parsed }];
    }
    return [];
}

// Qualquer atendente pode adicionar um procedimento orçado — não apaga os
// que já existem (diferente do PUT /api/leads/:id genérico, que sobrescrevia
// o campo "orcamento" inteiro).
app.post('/api/leads/:id/orcamentos', async (req, res) => {
    const { id } = req.params;
    const { procedimento, valor, desconto, formaPagamento, condicoes } = req.body;
    try {
        const leadRows = await queryD1('SELECT orcamento, owner_id, column_id FROM leads WHERE id = ?', [id]);
        if (!leadRows || leadRows.length === 0) return res.status(404).json({ error: 'Lead não encontrado' });

        const items = parseOrcamentoArray(leadRows[0].orcamento);
        const eraPrimeiroItem = items.length === 0;
        const colunaAnterior = leadRows[0].column_id;
        const newItem = {
            id: `orc-${Date.now()}`,
            procedimento: procedimento || '',
            valor: valor || '',
            desconto: desconto || '',
            formaPagamento: formaPagamento || '',
            condicoes: condicoes || '',
            created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
            created_by: req.user?.username || null
        };
        items.push(newItem);

        let updateOwnerSql = '';
        const params = [JSON.stringify(items), 'col-orcado', newItem.created_at];
        
        if (!leadRows[0].owner_id && req.user && req.user.username) {
            updateOwnerSql = ', owner_id = ?, assigned_at = CURRENT_TIMESTAMP';
            params.push(req.user.username);
        }
        params.push(id);

        await queryD1(
            `UPDATE leads SET orcamento = ?, column_id = ?, data_valor = ? ${updateOwnerSql} WHERE id = ?`,
            params
        );

        // Histórico estruturado.
        if (updateOwnerSql) logLeadEvent(id, 'atendimento_iniciado', req.user?.username, 'via abertura de orçamento');
        if (eraPrimeiroItem) logLeadEvent(id, 'orcamento_aberto', req.user?.username, newItem.procedimento);
        if (colunaAnterior !== 'col-orcado') logLeadEvent(id, 'mudanca_coluna', req.user?.username, JSON.stringify({ de: colunaAnterior, para: 'col-orcado' }));

        try {
            if (newItem.procedimento) {
                await queryD1(
                    'UPDATE agendamentos_financeiro SET procedimento = ?, orcado_por = ? WHERE lead_id = ?',
                    [newItem.procedimento, newItem.created_by, id]
                );
            }
        } catch (err) { console.error('Erro na cascata do histórico financeiro:', err); }

        await syncLeadPagamento(id);
        res.status(201).json({ success: true, item: newItem, items });
    } catch (e) {
        console.error('Erro ao adicionar orçamento:', e);
        res.status(500).json({ error: 'Erro interno ao adicionar orçamento.' });
    }
});

// Editar e excluir um procedimento já orçado é só pra admin — evita que um
// orçamento fechado com o paciente seja alterado/apagado por engano.
app.put('/api/leads/:id/orcamentos/:orcId', async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradores podem editar um orçamento já registrado.' });
    }
    const { id, orcId } = req.params;
    const { procedimento, valor, desconto, formaPagamento, condicoes } = req.body;
    try {
        const leadRows = await queryD1('SELECT orcamento FROM leads WHERE id = ?', [id]);
        if (!leadRows || leadRows.length === 0) return res.status(404).json({ error: 'Lead não encontrado' });

        const items = parseOrcamentoArray(leadRows[0].orcamento);
        const idx = items.findIndex(i => i.id === orcId);
        if (idx === -1) return res.status(404).json({ error: 'Procedimento orçado não encontrado' });

        items[idx] = { ...items[idx], procedimento, valor, desconto, formaPagamento, condicoes };
        await queryD1('UPDATE leads SET orcamento = ? WHERE id = ?', [JSON.stringify(items), id]);

        try {
            if (procedimento) {
                await queryD1('UPDATE agendamentos_financeiro SET procedimento = ? WHERE lead_id = ?', [procedimento, id]);
            }
        } catch (err) { console.error('Erro na cascata do histórico financeiro:', err); }

        await syncLeadPagamento(id);
        res.json({ success: true, items });
    } catch (e) {
        console.error('Erro ao editar orçamento:', e);
        res.status(500).json({ error: 'Erro interno ao editar orçamento.' });
    }
});

app.delete('/api/leads/:id/orcamentos/:orcId', async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradores podem excluir um orçamento já registrado.' });
    }
    const { id, orcId } = req.params;
    try {
        const leadRows = await queryD1('SELECT orcamento FROM leads WHERE id = ?', [id]);
        if (!leadRows || leadRows.length === 0) return res.status(404).json({ error: 'Lead não encontrado' });

        const items = parseOrcamentoArray(leadRows[0].orcamento).filter(i => i.id !== orcId);
        await queryD1('UPDATE leads SET orcamento = ? WHERE id = ?', [JSON.stringify(items), id]);
        await syncLeadPagamento(id);
        res.json({ success: true, items });
    } catch (e) {
        console.error('Erro ao excluir orçamento:', e);
        res.status(500).json({ error: 'Erro interno ao excluir orçamento.' });
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
            broadcastLeadsUpdate('updated', id);
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

// ==== PRESENÇA EM CONVERSA (avatar do atendente no card do chat) ====
// Só informativo. Não mexe em owner_id/assigned_at. Um atendente "está na
// conversa" enquanto pinga; a presença vence sozinha após PRESENCE_TTL_SECONDS.
const PRESENCE_TTL_SECONDS = 60;

// Entrou na conversa / segue nela (ping a cada ~20s pelo front).
app.post('/api/leads/:id/viewing', async (req, res) => {
    const { id } = req.params;
    const username = req.user.username;
    try {
        await queryD1(
            `INSERT INTO crm_chat_presence (lead_id, username, entered_at, last_ping_at)
             VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(lead_id, username) DO UPDATE SET last_ping_at = CURRENT_TIMESTAMP`,
            [id, username]
        );
        broadcastLeadsUpdate('presence', id);
        res.json({ success: true });
    } catch (e) {
        console.error('Erro ao registrar presença na conversa:', e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// Saiu da conversa (troca de conversa / fechou a aba — via sendBeacon).
app.post('/api/leads/:id/leave', async (req, res) => {
    const { id } = req.params;
    const username = req.user.username;
    try {
        await queryD1('DELETE FROM crm_chat_presence WHERE lead_id = ? AND username = ?', [id, username]);
        broadcastLeadsUpdate('presence', id);
        res.json({ success: true });
    } catch (e) {
        console.error('Erro ao sair da presença da conversa:', e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// Quem está em cada conversa agora. Ignora pings vencidos e faz uma faxina barata
// das linhas bem antigas. Resposta: { "<leadId>": [{ username, display_name, avatar_url }] }
app.get('/api/chat-presence', async (req, res) => {
    try {
        queryD1("DELETE FROM crm_chat_presence WHERE last_ping_at < datetime('now', '-1 hour')").catch(() => {});
        const rows = await queryD1(
            `SELECT p.lead_id, p.username, u.display_name, u.avatar_url
             FROM crm_chat_presence p
             LEFT JOIN crm_users u ON u.username = p.username
             WHERE p.last_ping_at > datetime('now', '-${PRESENCE_TTL_SECONDS} seconds')
             ORDER BY p.entered_at ASC`
        );
        const map = {};
        (rows || []).forEach(r => {
            (map[r.lead_id] = map[r.lead_id] || []).push({
                username: r.username,
                display_name: r.display_name || r.username,
                avatar_url: r.avatar_url || null
            });
        });
        res.json(map);
    } catch (e) {
        console.error('Erro ao listar presença nas conversas:', e);
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

        const isAdmin = req.user.role === 'admin' || req.user.username === 'admin';
        if (isAdmin) {
            await queryD1(
                `UPDATE leads SET owner_id = ?, assigned_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [to, id]
            );
        } else {
            await queryD1(
                `UPDATE leads SET owner_id = ?, assigned_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?`,
                [to, id, username]
            );
        }

        const rows = await queryD1('SELECT id, owner_id, assigned_at FROM leads WHERE id = ?', [id]);
        const lead = rows && rows[0];
        if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });

        if (lead.owner_id === to) {
            broadcastLeadsUpdate('updated', id);
            return res.json({ success: true, owner_id: lead.owner_id, assigned_at: lead.assigned_at });
        }
        return res.status(409).json({ error: 'Você não está mais com essa conversa pra poder transferir.', owner_id: lead.owner_id, assigned_at: lead.assigned_at });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// Devolver a conversa para a IA: tira o responsável humano, religa a IA do lead,
// encerra qualquer fluxo que esteja "segurando" a conversa e, se o lead estiver
// fora das colunas que a IA atende, traz de volta pra "col-contatado".
app.post('/api/leads/:id/handoff-ai', async (req, res) => {
    const { id } = req.params;
    try {
        const rows = await queryD1('SELECT id, column_id, tags, telefone FROM leads WHERE id = ?', [id]);
        const lead = rows && rows[0];
        if (!lead) return res.status(404).json({ error: 'Lead não encontrado.' });

        const AI_COLS = ['col-entrada', 'col-contatado'];
        const LOCKED_COLS = ['col-ganho', 'col-perdido'];
        let warning = null;
        let targetCol = lead.column_id;
        if (!AI_COLS.includes(lead.column_id)) {
            if (LOCKED_COLS.includes(lead.column_id)) {
                warning = 'Lead está em "' + lead.column_id + '". A IA não atende nessa coluna — mova pro funil se quiser que ela responda.';
            } else {
                targetCol = 'col-contatado';
            }
        }

        // tira a tag de handoff pra não ficar preso em "Qualificados aguardando"
        const curTags = lead.tags ? String(lead.tags).split(',').map(s => s.trim()).filter(Boolean) : [];
        const newTags = curTags.filter(t => t !== 'ia-qualificado').join(',');

        await queryD1(
            'UPDATE leads SET owner_id = NULL, assigned_at = NULL, ai_enabled = 1, column_id = ?, tags = ?, qualificado_em = NULL WHERE id = ?',
            [targetCol, newTags, id]
        );
        logLeadEvent(id, 'devolvido_para_ia', req.user?.username);

        // encerra fluxos ativos desse número (senão flowDispatchInbound continua
        // interceptando e a IA nunca responde)
        try {
            const variants = phoneVariants(lead.telefone || '');
            if (variants.length) {
                const ph = variants.map(() => '?').join(', ');
                await queryD1(
                    `UPDATE crm_flow_runs SET status = 'done', updated_at = CURRENT_TIMESTAMP WHERE phone IN (${ph}) AND status IN ('running','waiting_reply','sleeping')`,
                    variants
                );
            }
        } catch (e) { console.error('handoff-ai: encerrar fluxos falhou:', e.message); }

        // Se o lead mandou a última mensagem (está esperando resposta), a IA assume
        // agora — responde a pendência lendo o histórico. Se a última foi nossa,
        // só religa e aguarda a próxima mensagem dele.
        let respondeuAgora = false;
        if (!warning) {
            try {
                const variants = phoneVariants(lead.telefone || '');
                if (variants.length) {
                    const vp = variants.map(() => '?').join(', ');
                    const lastMsg = await queryD1(
                        `SELECT id, direction, timestamp FROM wa_messages WHERE phone IN (${vp}) ORDER BY timestamp DESC LIMIT 1`,
                        variants
                    );
                    if (lastMsg && lastMsg[0] && lastMsg[0].direction === 'in') {
                        // await obrigatório: na Vercel a função congela após a resposta HTTP.
                        await handleWhatsappAiAutoReply(id, lead.telefone, lastMsg[0].id, lastMsg[0].timestamp).catch(e => console.error('handoff-ai: IA falhou:', e));
                        respondeuAgora = true;
                    }
                }
            } catch (e) { console.error('handoff-ai: disparo da IA falhou:', e.message); }
        }

        broadcastLeadsUpdate('updated', id);
        res.json({ success: true, column_id: targetCol, warning, responded_now: respondeuAgora });
    } catch (e) {
        console.error('handoff-ai erro:', e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// Encerrar atendimento: o atendente terminou sua parte na conversa. Libera a
// trava na hora (não espera o timeout de inatividade), registra quem encerrou
// e religa a IA pra ela assumir a próxima mensagem — sem mexer na coluna do
// Kanban, que é o funil de venda, uma dimensão separada de "quem está
// conversando agora".
app.post('/api/leads/:id/end-service', async (req, res) => {
    const { id } = req.params;
    const username = (req.user && req.user.username) || 'atendente';
    try {
        const rows = await queryD1('SELECT id, telefone, notas FROM leads WHERE id = ?', [id]);
        const lead = rows && rows[0];
        if (!lead) return res.status(404).json({ error: 'Lead não encontrado.' });

        const carimbo = `✅ Atendimento encerrado por ${username} em ${new Date().toLocaleString('pt-BR')} — devolvido pra fila e pra IA.`;
        const notaAtual = lead.notas || '';
        const novaNota = `${notaAtual}${notaAtual ? '\n' : ''}${carimbo}`;

        await queryD1(
            'UPDATE leads SET owner_id = NULL, assigned_at = NULL, ai_enabled = 1, notas = ? WHERE id = ?',
            [novaNota, id]
        );
        logLeadEvent(id, 'atendimento_finalizado', username);

        // Encerra fluxos ativos desse número — senão flowDispatchInbound continua
        // interceptando a próxima mensagem e a IA nunca chega a responder.
        try {
            const variants = phoneVariants(lead.telefone || '');
            if (variants.length) {
                const ph = variants.map(() => '?').join(', ');
                await queryD1(
                    `UPDATE crm_flow_runs SET status = 'done', updated_at = CURRENT_TIMESTAMP WHERE phone IN (${ph}) AND status IN ('running','waiting_reply','sleeping')`,
                    variants
                );
            }
        } catch (e) { console.error('end-service: encerrar fluxos falhou:', e.message); }

        await syncLeadPagamento(id, 'end-service');
        markLeadPagDirty(id);
        broadcastLeadsUpdate('updated', id);
        res.json({ success: true });
    } catch (e) {
        console.error('end-service erro:', e);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// "Finalizar atendimento" — descarta o lead de vez: desliga a IA, desatribui,
// opta por não receber campanha, para follow-ups e fluxos e move pra "Follow
// Up/Perdido" com a etiqueta "descartado". NÃO bloqueia o número — se o lead
// mandar mensagem de novo, ela continua chegando normalmente no chat (só não
// dispara mais follow-up automático nem IA, a menos que reativado).
// Reversível: tirar o opt-out + a tag + mover a coluna de volta.
app.post('/api/leads/:id/discard', async (req, res) => {
    const { id } = req.params;
    const username = (req.user && req.user.username) || 'atendente';
    try {
        const rows = await queryD1('SELECT id, telefone, notas, tags, column_id FROM leads WHERE id = ?', [id]);
        const lead = rows && rows[0];
        if (!lead) return res.status(404).json({ error: 'Lead não encontrado.' });

        const variants = phoneVariants(lead.telefone || '');
        const ph = variants.length ? variants.map(() => '?').join(', ') : null;

        const discardedTagId = await ensureDiscardedTagExists();
        const curTags = (lead.tags || '').split(',').map(t => t.trim()).filter(Boolean);
        if (!curTags.includes(discardedTagId)) curTags.push(discardedTagId);

        const carimbo = `🚫 Atendimento finalizado por ${username} em ${new Date().toLocaleString('pt-BR')} — lead descartado: IA e follow-up desligados, campanhas bloqueadas.`;
        const novaNota = `${lead.notas || ''}${lead.notas ? '\n' : ''}${carimbo}`;

        logLeadEvent(id, 'lead_descartado', username);
        if (lead.column_id !== 'col-perdido') {
            logLeadEvent(id, 'mudanca_coluna', username, JSON.stringify({ de: lead.column_id, para: 'col-perdido' }));
        }
        await queryD1(
            "UPDATE leads SET ai_enabled = 0, owner_id = NULL, assigned_at = NULL, campaign_opt_out = 1, column_id = 'col-perdido', tags = ?, notas = ? WHERE id = ?",
            [curTags.join(','), novaNota, id]
        );

        // Para follow-ups em andamento (por lead_id e por telefone) e encerra fluxos.
        try {
            await queryD1("UPDATE crm_followup_runs SET status = 'parado', updated_at = CURRENT_TIMESTAMP WHERE lead_id = ? AND status IN ('agendado','enviando')", [id]);
            if (ph) {
                await queryD1(`UPDATE crm_followup_runs SET status = 'parado', updated_at = CURRENT_TIMESTAMP WHERE phone IN (${ph}) AND status IN ('agendado','enviando')`, variants);
                await queryD1(`UPDATE crm_flow_runs SET status = 'done', updated_at = CURRENT_TIMESTAMP WHERE phone IN (${ph}) AND status IN ('running','waiting_reply','sleeping')`, variants);
            }
        } catch (e) { console.error('discard: parar follow-up/fluxos falhou:', e.message); }

        // Lead descartado (-> col-perdido): tira o dinheiro do Financeiro.
        await syncLeadPagamento(id, 'discard');
        markLeadPagDirty(id);
        broadcastLeadsUpdate('updated', id);
        res.json({ success: true });
    } catch (e) {
        console.error('discard erro:', e);
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
        // Agendamento novo com lead vinculado: dispara Schedule pelo mesmo wrapper,
        // aproveitando o ctwa_clid gravado no lead. Sem lead_id, cai no envio direto.
        if (!payload.attendance_id) {
            if (payload.lead_id) {
                await fireCapiForLead(payload.lead_id, 'Schedule').catch(e => console.error('CAPI Schedule:', e.message));
            } else {
                sendMetaCapiEvent('Schedule', {
                    telefone: payload.patient_phone,
                    email: payload.patient_email,
                    nome: payload.patient_name
                });
            }
        }
        
        res.status(200).json({ 
            success: true, 
            message: payload.attendance_id ? 'Agendamento atualizado com sucesso!' : 'Agendamento criado via API Real do Amigo App!' 
        });
    } catch (error) {
        res.status(400).json({ error: error.message, details: error.message });
    }
});

app.get('/api/leads/:id/agendamentos', async (req, res) => {
    const { id } = req.params;
    try {
        const rows = await queryD1(
            'SELECT * FROM agendamentos_financeiro WHERE lead_id = ? ORDER BY created_at DESC',
            [id]
        );
        res.json(rows || []);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro interno.' });
    }
});

// Último atendente humano que respondeu esse lead pelo WhatsApp (pra ficha do lead).
app.get('/api/leads/:id/ultimo-atendente', async (req, res) => {
    const { id } = req.params;
    try {
        const leadRows = await queryD1('SELECT telefone FROM leads WHERE id = ?', [id]);
        const lead = leadRows && leadRows[0];
        if (!lead || !lead.telefone) return res.json({ atendente: null });

        const variants = phoneVariants(lead.telefone);
        const placeholders = variants.map(() => '?').join(', ');
        const rows = await queryD1(
            `SELECT sent_by, timestamp, message FROM wa_messages
             WHERE phone IN (${placeholders}) AND direction = 'out'
             ORDER BY timestamp DESC LIMIT 25`,
            variants
        );

        let username = null, quando = null, viaIa = false;
        for (const r of (rows || [])) {
            if (r.sent_by && r.sent_by !== 'ia') { username = r.sent_by; quando = r.timestamp; break; }
            if (!quando) { quando = r.timestamp; viaIa = viaIa || r.sent_by === 'ia'; }
            // Legado sem sent_by: tenta extrair a assinatura "_Nome – Clínica_" da última linha.
            if (!username && (!r.sent_by || r.sent_by === null)) {
                const m = String(r.message || '').match(/_([^_–-]+?)\s*[–-]\s*[^_]+_\s*$/);
                if (m) { username = m[1].trim(); quando = r.timestamp; break; }
            }
        }

        let displayName = username;
        if (username) {
            try {
                const u = await queryD1('SELECT display_name FROM crm_users WHERE username = ?', [username]);
                if (u && u[0] && u[0].display_name) displayName = u[0].display_name;
            } catch (e) {}
        }

        res.json({
            atendente: displayName,
            username: username,
            quando: quando || null,
            via_ia: !username && viaIa
        });
    } catch (e) {
        console.error('Erro ao buscar último atendente:', e);
        res.status(500).json({ error: 'Erro interno.' });
    }
});

// Deletar um lead
app.delete('/api/leads/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await queryD1('DELETE FROM leads WHERE id = ?', [id]);
        broadcastLeadsUpdate('deleted', id);
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
async function getMergedAgendamentos(startDate, endDate, opts = {}) {
    // onlyLocal: descarta os agendamentos que vieram só do Amigo App (marcados
    // direto lá, sem passar por este CRM) — deixa só os que este sistema criou
    // (têm registro em agendamentos_financeiro).
    const { onlyLocal = false } = opts;
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
        if (onlyLocal && !local) return null;
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
            agendado_por: (local && local.agendado_por) || '-',
            orcado_por: (local && local.orcado_por) || '-'
        };
    }).filter(Boolean);

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
            agendado_por: row.agendado_por || '-',
            orcado_por: row.orcado_por || '-'
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

        // Por padrão mostra só os agendamentos deste sistema; only_local=0 traz
        // também os feitos direto no Amigo App.
        const onlyLocal = req.query.only_local !== '0';
        const merged = await getMergedAgendamentos(startDate, endDate, { onlyLocal });
        res.json(merged);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message || 'Erro interno do servidor.' });
    }
});

// ==========================================
// FINANCEIRO — Recebimentos (ledger) e Contas a Receber
// ==========================================
const FORMAS_PAGAMENTO = ['pix', 'dinheiro', 'cartao_credito', 'cartao_debito', 'boleto', 'transferencia', 'outro'];
const STATUS_PAGAMENTO = ['pendente', 'pago', 'cancelado'];

function fmtPagamento(r) {
    return {
        ...r,
        valor: centsToBRL(r.valor_centavos),
        valor_reais: (Number(r.valor_centavos) || 0) / 100,
    };
}

// Lista lançamentos. Filtros: lead_id, attendance_id, status, tipo, start, end
// (período pela "data de referência" = pago_em, senão vencimento, senão criação).
app.get('/api/pagamentos', async (req, res) => {
    try {
        const { lead_id, attendance_id, status, tipo, start, end } = req.query;
        const where = [], params = [];
        if (lead_id) { where.push('lead_id = ?'); params.push(lead_id); }
        if (attendance_id) { where.push('attendance_id = ?'); params.push(attendance_id); }
        if (status) { where.push('status = ?'); params.push(status); }
        if (tipo) { where.push('tipo = ?'); params.push(tipo); }

        let rows = await queryD1(
            `SELECT * FROM crm_pagamentos ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
             ORDER BY COALESCE(pago_em, vencimento, date(created_at)) DESC, id DESC`,
            params
        );

        if (start || end) {
            rows = rows.filter(r => {
                const ref = r.pago_em || r.vencimento || (r.created_at || '').split(' ')[0];
                if (start && ref < start) return false;
                if (end && ref > end) return false;
                return true;
            });
        }
        res.json({ data: rows.map(fmtPagamento) });
    } catch (e) {
        console.error('Erro ao listar pagamentos:', e);
        res.status(500).json({ error: e.message || 'Erro interno.' });
    }
});

// Cria um recebimento. parcelas_total > 1 gera N linhas (1 por parcela),
// dividindo o valor em centavos sem perder resto e somando 1 mês ao vencimento
// a cada parcela. pago_em só se aplica à 1ª parcela (entrada/à vista).
app.post('/api/pagamentos', async (req, res) => {
    try {
        const { lead_id, attendance_id, descricao, paciente, valor, valor_centavos,
            forma_pagamento, status, vencimento, pago_em, parcelas_total } = req.body;

        const totalCents = valor_centavos != null ? Math.round(Number(valor_centavos)) : brlToCents(valor);
        if (!totalCents || totalCents <= 0) return res.status(400).json({ error: 'Valor inválido.' });
        if (forma_pagamento && !FORMAS_PAGAMENTO.includes(forma_pagamento)) {
            return res.status(400).json({ error: 'Forma de pagamento inválida.' });
        }

        const n = Math.max(1, Math.min(48, parseInt(parcelas_total, 10) || 1));
        const criado_por = req.user?.username || null;
        const base = Math.floor(totalCents / n);
        const resto = totalCents - base * n;
        const baseVenc = vencimento ? new Date(vencimento + 'T00:00:00') : null;

        for (let i = 0; i < n; i++) {
            const parcelaCents = base + (i < resto ? 1 : 0);
            let venc = null;
            if (baseVenc) {
                const d = new Date(baseVenc);
                d.setMonth(d.getMonth() + i);
                venc = d.toISOString().split('T')[0];
            }
            const pgEm = (i === 0 && pago_em) ? pago_em : null;
            let st = 'pendente';
            if (pgEm) st = 'pago';
            else if (n === 1 && status && STATUS_PAGAMENTO.includes(status)) st = status;
            const finalPgEm = (st === 'pago' && !pgEm) ? todayISO() : pgEm;

            await queryD1(
                `INSERT INTO crm_pagamentos
                   (lead_id, attendance_id, descricao, paciente, valor_centavos, tipo,
                    forma_pagamento, status, vencimento, pago_em, parcela, parcelas_total, criado_por)
                 VALUES (?, ?, ?, ?, ?, 'recebimento', ?, ?, ?, ?, ?, ?, ?)`,
                [lead_id || null, attendance_id || null, descricao || null, paciente || null,
                 parcelaCents, forma_pagamento || null, st, venc, finalPgEm, i + 1, n, criado_por]
            );
        }
        // origem_sync fica NULL -> a migração do boot rotula como 'manual'. Pro
        // syncLeadPagamento, NULL e 'manual' são equivalentes (nenhum dos dois é
        // linha gerida pelo Kanban), então não há janela de inconsistência.
        res.status(201).json({ success: true, parcelas: n });
    } catch (e) {
        console.error('Erro ao criar pagamento:', e);
        res.status(400).json({ error: e.message || 'Erro ao registrar recebimento.' });
    }
});

// Atualiza status/vencimento/forma/descrição de um lançamento (ex.: marcar pago).
app.patch('/api/pagamentos/:id', async (req, res) => {
    try {
        const { status, pago_em, vencimento, forma_pagamento, descricao } = req.body;
        const sets = [], params = [];

        if (status !== undefined) {
            if (!STATUS_PAGAMENTO.includes(status)) return res.status(400).json({ error: 'Status inválido.' });
            sets.push('status = ?'); params.push(status);
            if (status === 'pago' && pago_em === undefined) { sets.push('pago_em = ?'); params.push(todayISO()); }
            if (status === 'pendente') sets.push('pago_em = NULL');
        }
        if (pago_em !== undefined) { sets.push('pago_em = ?'); params.push(pago_em || null); }
        if (vencimento !== undefined) { sets.push('vencimento = ?'); params.push(vencimento || null); }
        if (forma_pagamento !== undefined) {
            if (forma_pagamento && !FORMAS_PAGAMENTO.includes(forma_pagamento)) {
                return res.status(400).json({ error: 'Forma de pagamento inválida.' });
            }
            sets.push('forma_pagamento = ?'); params.push(forma_pagamento || null);
        }
        if (descricao !== undefined) { sets.push('descricao = ?'); params.push(descricao || null); }

        if (!sets.length) return res.status(400).json({ error: 'Nada para atualizar.' });
        params.push(req.params.id);
        await queryD1(`UPDATE crm_pagamentos SET ${sets.join(', ')} WHERE id = ?`, params);
        res.json({ success: true });
    } catch (e) {
        console.error('Erro ao atualizar pagamento:', e);
        res.status(400).json({ error: e.message || 'Erro ao atualizar.' });
    }
});

// Estorna um lançamento: cria uma linha 'estorno' com valor negativo e marca o
// original como 'cancelado'. O líquido do período passa a ser a soma dos dois.
app.post('/api/pagamentos/:id/estorno', async (req, res) => {
    try {
        const rows = await queryD1('SELECT * FROM crm_pagamentos WHERE id = ?', [req.params.id]);
        if (!rows.length) return res.status(404).json({ error: 'Lançamento não encontrado.' });
        const orig = rows[0];
        if (orig.tipo === 'estorno') return res.status(400).json({ error: 'Não é possível estornar um estorno.' });
        if (orig.status === 'cancelado') return res.status(400).json({ error: 'Lançamento já está cancelado.' });

        await queryD1(
            `INSERT INTO crm_pagamentos
               (lead_id, attendance_id, descricao, paciente, valor_centavos, tipo,
                forma_pagamento, status, vencimento, pago_em, parcela, parcelas_total, estorno_de, criado_por)
             VALUES (?, ?, ?, ?, ?, 'estorno', ?, 'pago', NULL, ?, ?, ?, ?, ?)`,
            [orig.lead_id, orig.attendance_id,
             'Estorno: ' + (orig.descricao || ('lançamento #' + orig.id)),
             orig.paciente, -Math.abs(orig.valor_centavos), orig.forma_pagamento,
             todayISO(), orig.parcela, orig.parcelas_total, orig.id, req.user?.username || null]
        );
        await queryD1("UPDATE crm_pagamentos SET status = 'cancelado' WHERE id = ?", [orig.id]);
        res.json({ success: true });
    } catch (e) {
        console.error('Erro ao estornar pagamento:', e);
        res.status(400).json({ error: e.message || 'Erro ao estornar.' });
    }
});

// Exclusão definitiva — só admin. Leva junto o estorno vinculado, se houver.
app.delete('/api/pagamentos/:id', async (req, res) => {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradores podem excluir lançamentos.' });
    }
    try {
        await queryD1('DELETE FROM crm_pagamentos WHERE id = ? OR estorno_de = ?', [req.params.id, req.params.id]);
        res.json({ success: true });
    } catch (e) {
        console.error('Erro ao excluir pagamento:', e);
        res.status(500).json({ error: 'Erro interno.' });
    }
});

// ============================================================================
// PSP — cobrança Pix / boleto por fatura (Efí ou Asaas)
// Adaptador com interface única; a implementação real fica em _asaas* / _efi*.
// Sem PSP_PROVIDER, pspEnabled() = false e os endpoints respondem 501.
// ============================================================================
function pspProvider() { return (process.env.PSP_PROVIDER || '').trim().toLowerCase(); }
function pspIsSandbox() { return (process.env.PSP_ENV || 'sandbox').trim().toLowerCase() !== 'production'; }
function pspEnabled() {
    const p = pspProvider();
    if (p === 'asaas') return !!(process.env.ASAAS_API_KEY || '').trim();
    if (p === 'efi') return !!((process.env.EFI_CLIENT_ID || '').trim() && (process.env.EFI_CLIENT_SECRET || '').trim());
    return false;
}

// Formato normalizado que os endpoints e o front consomem, independente do PSP:
//   { provider, chargeId, metodo, qrcode, qrcodeImg, url, linhaDigitavel, expiraEm, status, raw }
async function pspCreateCharge({ valorCentavos, vencimento, metodo, paciente, cpf, email, telefone, endereco, descricao }) {
    const p = pspProvider();
    if (!pspEnabled()) { const e = new Error('PSP não configurado.'); e.code = 'PSP_OFF'; throw e; }
    if (!['pix', 'boleto'].includes(metodo)) throw new Error('Método deve ser "pix" ou "boleto".');
    const args = { valorCentavos, vencimento, metodo, paciente, cpf, email, telefone, endereco: endereco || {}, descricao };
    if (p === 'asaas') return _asaasCreateCharge(args);
    if (p === 'efi') return _efiCreateCharge(args);
    throw new Error('PSP_PROVIDER inválido: ' + p);
}

// Recebe o webhook do PSP. Retorna { chargeId, status: 'pago'|'pendente'|'expirado'|'cancelado', pagoEm } ou null se não for evento de pagamento.
async function pspParseWebhook(req) {
    const p = pspProvider();
    if (p === 'asaas') return _asaasParseWebhook(req);
    if (p === 'efi') return _efiParseWebhook(req);
    return null;
}

// ---- Asaas ----
function _asaasBase() { return pspIsSandbox() ? 'https://sandbox.asaas.com/api/v3' : 'https://www.asaas.com/api/v3'; }
async function _asaasFetch(path, opts = {}) {
    const r = await fetch(_asaasBase() + path, {
        ...opts,
        headers: { 'Content-Type': 'application/json', access_token: (process.env.ASAAS_API_KEY || '').trim(), ...(opts.headers || {}) }
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
        const msg = (j.errors && j.errors[0] && j.errors[0].description) || j.message || ('HTTP ' + r.status);
        throw new Error('Asaas: ' + msg);
    }
    return j;
}
async function _asaasCreateCharge({ valorCentavos, vencimento, metodo, paciente, cpf, email, telefone, endereco, descricao }) {
    const end = endereco || {};
    // 1. cliente (Asaas exige um customer por cobrança)
    const cli = await _asaasFetch('/customers', {
        method: 'POST',
        body: JSON.stringify({
            name: paciente || 'Paciente',
            cpfCnpj: (cpf || '').replace(/\D/g, '') || undefined,
            email: email || undefined,
            phone: (telefone || '').replace(/\D/g, '') || undefined,
            postalCode: (end.cep || '').replace(/\D/g, '') || undefined,
            address: end.logradouro || undefined,
            addressNumber: end.numero || undefined,
            complement: end.complemento || undefined,
            province: end.bairro || undefined
        })
    });
    // 2. cobrança
    const pay = await _asaasFetch('/payments', {
        method: 'POST',
        body: JSON.stringify({
            customer: cli.id,
            billingType: metodo === 'boleto' ? 'BOLETO' : 'PIX',
            value: Math.round(valorCentavos) / 100,
            dueDate: vencimento || todayISO(),
            description: descricao || 'Fatura'
        })
    });
    const out = {
        provider: 'asaas', chargeId: String(pay.id), metodo,
        qrcode: null, qrcodeImg: null, url: pay.invoiceUrl || null,
        linhaDigitavel: null, expiraEm: vencimento || null,
        status: 'pendente', raw: pay
    };
    if (metodo === 'pix') {
        const qr = await _asaasFetch('/payments/' + pay.id + '/pixQrCode').catch(() => ({}));
        out.qrcode = qr.payload || null;
        out.qrcodeImg = qr.encodedImage ? ('data:image/png;base64,' + qr.encodedImage) : null;
        out.expiraEm = qr.expirationDate || out.expiraEm;
    } else {
        out.url = pay.bankSlipUrl || pay.invoiceUrl || out.url;
        const idf = await _asaasFetch('/payments/' + pay.id + '/identificationField').catch(() => ({}));
        out.linhaDigitavel = idf.identificationField || null;
    }
    return out;
}
function _asaasParseWebhook(req) {
    const tok = (process.env.PSP_WEBHOOK_TOKEN || '').trim();
    if (tok && req.get('asaas-access-token') !== tok) { const e = new Error('token inválido'); e.code = 'BAD_SIG'; throw e; }
    const b = req.body || {};
    if (!b.payment || !b.payment.id) return null;
    const st = String(b.payment.status || '').toUpperCase();
    const map = { RECEIVED: 'pago', CONFIRMED: 'pago', RECEIVED_IN_CASH: 'pago', OVERDUE: 'pendente', PENDING: 'pendente', REFUNDED: 'cancelado', DELETED: 'cancelado' };
    return {
        chargeId: String(b.payment.id),
        status: map[st] || 'pendente',
        pagoEm: (b.payment.paymentDate || b.payment.clientPaymentDate || '').split('T')[0] || todayISO()
    };
}

// ---- Efí / Gerencianet (Pix; boleto exige a API de Cobranças, ainda não coberta) ----
let _efiAgentPromise = null;
async function _efiAgent() {
    // mTLS: Pix da Efí só responde com o certificado .p12 no handshake.
    if (_efiAgentPromise) return _efiAgentPromise;
    _efiAgentPromise = (async () => {
        let pfx = null;
        const b64 = (process.env.EFI_CERT_BASE64 || '').trim();
        const pth = (process.env.EFI_CERT_PATH || '').trim();
        if (b64) pfx = Buffer.from(b64, 'base64');
        else if (pth) pfx = fs.readFileSync(pth);
        if (!pfx) throw new Error('Efí Pix precisa do certificado mTLS — configure EFI_CERT_PATH ou EFI_CERT_BASE64.');
        let Agent;
        try { ({ Agent } = await import('undici')); }
        catch (e) { throw new Error('Efí Pix precisa do pacote undici — rode: npm i undici'); }
        return new Agent({ connect: { pfx, passphrase: (process.env.EFI_CERT_PASSWORD || '').trim() || undefined } });
    })();
    return _efiAgentPromise;
}
function _efiBase() { return pspIsSandbox() ? 'https://pix-h.api.efipay.com.br' : 'https://pix.api.efipay.com.br'; }
async function _efiToken() {
    const agent = await _efiAgent();
    const basic = Buffer.from(`${(process.env.EFI_CLIENT_ID || '').trim()}:${(process.env.EFI_CLIENT_SECRET || '').trim()}`).toString('base64');
    const r = await fetch(_efiBase() + '/oauth/token', {
        method: 'POST', dispatcher: agent,
        headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credentials' })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error('Efí: falha no OAuth (' + (j.error_description || r.status) + ')');
    return j.access_token;
}
async function _efiCreateCharge({ valorCentavos, vencimento, metodo, paciente, cpf, endereco, descricao }) {
    // endereco só é usado no boleto (API de Cobranças da Efí); o Pix /v2/cob não aceita endereço no devedor.
    if (metodo === 'boleto') throw new Error('Boleto pela Efí ainda não implementado aqui — use Asaas pra boleto, ou peça a integração da API de Cobranças da Efí.');
    const agent = await _efiAgent();
    const token = await _efiToken();
    const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    // Expira em segundos: da criação até o fim do dia de vencimento (ou 3 dias).
    let expiracao = 3 * 86400;
    if (vencimento) {
        const diff = Math.round((new Date(vencimento + 'T23:59:59') - Date.now()) / 1000);
        if (diff > 60) expiracao = diff;
    }
    const cobRes = await fetch(_efiBase() + '/v2/cob', {
        method: 'POST', dispatcher: agent, headers: H,
        body: JSON.stringify({
            calendario: { expiracao },
            valor: { original: (Math.round(valorCentavos) / 100).toFixed(2) },
            chave: (process.env.EFI_PIX_KEY || '').trim(),
            devedor: cpf ? { cpf: (cpf || '').replace(/\D/g, ''), nome: paciente || 'Paciente' } : undefined,
            solicitacaoPagador: (descricao || 'Fatura').slice(0, 140)
        })
    });
    const cob = await cobRes.json().catch(() => ({}));
    if (!cobRes.ok) throw new Error('Efí: ' + (cob.mensagem || (cob.violacoes && cob.violacoes[0] && cob.violacoes[0].razao) || cobRes.status));
    const locId = cob.loc && cob.loc.id;
    let qrcode = cob.pixCopiaECola || null, qrcodeImg = null;
    if (locId) {
        const qrRes = await fetch(_efiBase() + '/v2/loc/' + locId + '/qrcode', { dispatcher: agent, headers: H });
        const qr = await qrRes.json().catch(() => ({}));
        if (qrRes.ok) { qrcode = qr.qrcode || qrcode; qrcodeImg = qr.imagemQrcode || null; }
    }
    return {
        provider: 'efi', chargeId: String(cob.txid), metodo: 'pix',
        qrcode, qrcodeImg, url: null, linhaDigitavel: null,
        expiraEm: vencimento || null, status: 'pendente', raw: cob
    };
}
async function _efiParseWebhook(req) {
    // Efí manda { pix: [{ txid, valor, horario, endToEndId }] }. mTLS/HMAC do
    // webhook varia por config — aqui reconfirmamos o status na API antes de dar pago.
    const b = req.body || {};
    const ev = Array.isArray(b.pix) && b.pix[0];
    if (!ev || !ev.txid) return null;
    try {
        const agent = await _efiAgent();
        const token = await _efiToken();
        const r = await fetch(_efiBase() + '/v2/cob/' + ev.txid, { dispatcher: agent, headers: { Authorization: 'Bearer ' + token } });
        const cob = await r.json().catch(() => ({}));
        const st = String(cob.status || '').toUpperCase();
        const pago = st === 'CONCLUIDA';
        return { chargeId: String(ev.txid), status: pago ? 'pago' : (st === 'REMOVIDA_PELO_USUARIO_RECEBEDOR' ? 'cancelado' : 'pendente'), pagoEm: (ev.horario || '').split('T')[0] || todayISO() };
    } catch (e) {
        // Sem conseguir reconfirmar, assume pago pelo próprio evento (Efí só
        // dispara webhook de pix quando o dinheiro entrou).
        return { chargeId: String(ev.txid), status: 'pago', pagoEm: (ev.horario || '').split('T')[0] || todayISO() };
    }
}

// Gera (ou regenera) a cobrança de uma parcela.
// Valida CPF (dígitos verificadores). Aceita com ou sem máscara.
function cpfValido(v) {
    const c = String(v || '').replace(/\D/g, '');
    if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
    const dv = (base, pesoIni) => {
        let s = 0; for (let i = 0; i < base.length; i++) s += Number(base[i]) * (pesoIni - i);
        const r = (s * 10) % 11; return r === 10 ? 0 : r;
    };
    return dv(c.slice(0, 9), 10) === Number(c[9]) && dv(c.slice(0, 10), 11) === Number(c[10]);
}

// Completar dados de cobrança (CPF + endereço estruturado) num lead, direto
// do modal do Financeiro. Compõe também o `endereco` de exibição.
app.post('/api/leads/:id/dados-cobranca', async (req, res) => {
    try {
        const b = req.body || {};
        const set = {};
        if (b.cpf !== undefined) {
            const cpf = String(b.cpf).replace(/\D/g, '');
            if (cpf && !cpfValido(cpf)) return res.status(400).json({ error: 'CPF inválido.' });
            set.cpf = cpf || null;
        }
        for (const f of ['cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'uf']) {
            if (b[f] !== undefined) set[f] = String(b[f] || '').trim() || null;
        }
        if (b.cep !== undefined) {
            const cep = String(b.cep).replace(/\D/g, '');
            set.cep = cep ? cep.replace(/^(\d{5})(\d{3})$/, '$1-$2') : null;
        }
        if (!Object.keys(set).length) return res.status(400).json({ error: 'Nada para salvar.' });

        // Endereço de exibição = partes compostas (quando houver).
        const cur = (await queryD1('SELECT * FROM leads WHERE id = ?', [req.params.id]))[0] || {};
        const g = k => (set[k] !== undefined ? set[k] : cur[k]) || '';
        const linha = [g('logradouro') + (g('numero') ? ', ' + g('numero') : ''), g('complemento'), g('bairro'),
            [g('cidade'), g('uf')].filter(Boolean).join(' - '), g('cep')].filter(Boolean).join(', ');
        if (linha) set.endereco = linha;

        const cols = Object.keys(set);
        await queryD1(`UPDATE leads SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ?`, [...cols.map(c => set[c]), req.params.id]);
        res.json({ success: true, endereco: set.endereco || cur.endereco || '' });
    } catch (e) {
        console.error('[dados-cobranca]', e.message);
        res.status(500).json({ error: 'Erro ao salvar.' });
    }
});

app.post('/api/pagamentos/:id/cobranca', async (req, res) => {
    if (!pspEnabled()) return res.status(501).json({ error: 'PSP não configurado. Preencha PSP_PROVIDER e as credenciais no .env.' });
    try {
        const metodo = (req.body && req.body.metodo) === 'boleto' ? 'boleto' : 'pix';
        const rows = await queryD1('SELECT * FROM crm_pagamentos WHERE id = ?', [req.params.id]);
        const pg = rows && rows[0];
        if (!pg) return res.status(404).json({ error: 'Lançamento não encontrado.' });
        if (pg.tipo !== 'recebimento') return res.status(400).json({ error: 'Só recebimentos geram cobrança.' });
        if (pg.status === 'pago') return res.status(400).json({ error: 'Essa parcela já está paga.' });
        if (pg.status === 'cancelado') return res.status(400).json({ error: 'Parcela cancelada.' });
        // Já tem cobrança viva do mesmo método? devolve ela.
        if (pg.psp_charge_id && pg.psp_metodo === metodo && pg.psp_status !== 'cancelado') {
            return res.json({ jaExistia: true, cobranca: _pspRowToPublic(pg) });
        }

        let L = {};
        if (pg.lead_id) {
            L = (await queryD1('SELECT cpf, email, telefone, cep, logradouro, numero, complemento, bairro, cidade, uf FROM leads WHERE id = ?', [pg.lead_id]).catch(() => []))[0] || {};
        }
        // Checa completude — abre o modal no front quando faltar algo.
        const faltando = [];
        if (!cpfValido(L.cpf)) faltando.push('cpf');
        if (metodo === 'boleto') {
            if (!L.cep) faltando.push('cep');
            if (!L.numero) faltando.push('numero');
            if (!L.logradouro) faltando.push('logradouro');
            if (!L.cidade) faltando.push('cidade');
            if (!L.uf) faltando.push('uf');
        }
        if (faltando.length) {
            return res.status(422).json({
                code: 'DADOS_INCOMPLETOS', error: 'Faltam dados do paciente para gerar a cobrança.',
                lead_id: pg.lead_id || null, metodo, faltando,
                atual: { cpf: L.cpf || '', cep: L.cep || '', logradouro: L.logradouro || '', numero: L.numero || '', complemento: L.complemento || '', bairro: L.bairro || '', cidade: L.cidade || '', uf: L.uf || '' }
            });
        }

        const c = await pspCreateCharge({
            valorCentavos: pg.valor_centavos,
            vencimento: pg.vencimento || null,
            metodo, paciente: pg.paciente, cpf: L.cpf, email: L.email, telefone: L.telefone,
            endereco: { cep: L.cep, logradouro: L.logradouro, numero: L.numero, complemento: L.complemento, bairro: L.bairro, cidade: L.cidade, uf: L.uf },
            descricao: pg.descricao || 'Fatura'
        });

        await queryD1(
            `UPDATE crm_pagamentos SET
               psp_provider = ?, psp_charge_id = ?, psp_metodo = ?, psp_qrcode = ?, psp_qrcode_img = ?,
               psp_url = ?, psp_linha_digitavel = ?, psp_expira_em = ?, psp_status = 'pendente',
               psp_criado_em = CURRENT_TIMESTAMP, psp_raw = ?
             WHERE id = ?`,
            [c.provider, c.chargeId, c.metodo, c.qrcode, c.qrcodeImg, c.url, c.linhaDigitavel, c.expiraEm,
             JSON.stringify(c.raw || {}).slice(0, 8000), req.params.id]
        );
        res.json({ cobranca: { ...c, id: Number(req.params.id) } });
    } catch (e) {
        console.error('[psp] criar cobrança:', e.message);
        res.status(e.code === 'PSP_OFF' ? 501 : 400).json({ error: e.message });
    }
});

function _pspRowToPublic(pg) {
    return {
        id: pg.id, provider: pg.psp_provider, chargeId: pg.psp_charge_id, metodo: pg.psp_metodo,
        qrcode: pg.psp_qrcode, qrcodeImg: pg.psp_qrcode_img, url: pg.psp_url,
        linhaDigitavel: pg.psp_linha_digitavel, expiraEm: pg.psp_expira_em, status: pg.psp_status
    };
}

// Devolve a cobrança já gerada (pra reabrir o QR). Regenera a imagem do QR a
// partir do copia-e-cola se ela não tiver sido salva.
app.get('/api/pagamentos/:id/cobranca', async (req, res) => {
    try {
        const rows = await queryD1('SELECT * FROM crm_pagamentos WHERE id = ?', [req.params.id]);
        const pg = rows && rows[0];
        if (!pg || !pg.psp_charge_id) return res.status(404).json({ error: 'Sem cobrança gerada.' });
        const pub = _pspRowToPublic(pg);
        if (!pub.qrcodeImg && pub.qrcode) {
            pub.qrcodeImg = await QRCode.toDataURL(pub.qrcode, { width: 320, margin: 1 }).catch(() => null);
        }
        res.json({ cobranca: pub });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Carnê: página HTML com todas as parcelas de um plano (uma por folha),
// pronta pra Ctrl+P -> "Salvar como PDF". ?ids=1,2,3
app.get('/api/pagamentos/carne', async (req, res) => {
    try {
        const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
        if (!ids.length) return res.status(400).send('Faltam os ids das parcelas.');
        const ph = ids.map(() => '?').join(',');
        const rows = await queryD1(
            `SELECT * FROM crm_pagamentos WHERE id IN (${ph}) AND tipo = 'recebimento' ORDER BY parcela ASC`, ids
        );
        if (!rows.length) return res.status(404).send('Nenhuma parcela encontrada.');

        const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const brl = c => 'R$ ' + ((Number(c) || 0) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
        const dt = s => { if (!s) return '—'; const p = String(s).slice(0, 10).split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : s; };
        const fmtCnpj = c => { const d = String(c || '').replace(/\D/g, ''); return d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : (c || ''); };
        const fmtCpf = c => { const d = String(c || '').replace(/\D/g, ''); return d.length === 11 ? d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : (c || ''); };
        const FORMA_LBL = { pix: 'Pix', boleto: 'Boleto bancário', dinheiro: 'Dinheiro', cartao_credito: 'Cartão de crédito', cartao_debito: 'Cartão de débito', transferencia: 'Transferência', outro: 'Outro' };

        const paciente = rows[0].paciente || 'Paciente';
        const descricao = rows[0].descricao || 'Parcelamento';
        const total = rows.reduce((s, r) => s + (Number(r.valor_centavos) || 0), 0);
        const totalPago = rows.filter(r => r.status === 'pago').reduce((s, r) => s + (Number(r.valor_centavos) || 0), 0);
        const saldo = total - totalPago;
        const pagas = rows.filter(r => r.status === 'pago').length;
        const nParc = rows[0].parcelas_total || rows.length;
        const primeiroVenc = rows.map(r => r.vencimento).filter(Boolean).sort()[0];
        const formaLbl = FORMA_LBL[rows[0].psp_metodo] || FORMA_LBL[rows[0].forma_pagamento] || '—';
        const emissao = dt(new Date().toISOString());
        // Referência do plano: menor id das parcelas, 6 dígitos. Nº do documento por parcela.
        const planoRef = String(Math.min(...rows.map(r => Number(r.id) || 0))).padStart(6, '0');
        const docNum = r => `${planoRef}-${String(r.parcela).padStart(2, '0')}/${r.parcelas_total}`;

        // Empresa (beneficiário): a do lead -> a padrão -> a primeira ativa. + dados do pagador.
        let emp = null, cpfPag = '', endPag = '', telPag = '', emailPag = '';
        try {
            const lid = rows.find(r => r.lead_id)?.lead_id;
            let empId = null;
            if (lid) {
                const lr = await queryD1('SELECT empresa_id, cpf, endereco, telefone, email FROM leads WHERE id = ?', [lid]);
                if (lr && lr[0]) { empId = lr[0].empresa_id; cpfPag = lr[0].cpf || ''; endPag = lr[0].endereco || ''; telPag = lr[0].telefone || ''; emailPag = lr[0].email || ''; }
            }
            emp = await resolveEmpresaParaLead(empId);
        } catch (e) { /* segue sem cabeçalho de empresa */ }
        const empNome = emp ? (emp.nome_fantasia || emp.razao_social) : '';
        const empSub = emp ? [emp.razao_social && emp.razao_social !== empNome ? emp.razao_social : '', emp.cnpj ? 'CNPJ ' + fmtCnpj(emp.cnpj) : ''].filter(Boolean).join(' · ') : '';
        const empContato = emp ? [emp.endereco, emp.telefone, emp.email, emp.site].filter(Boolean).join('  ·  ') : '';
        const cabecalhoEmpresa = (compacto) => emp ? `
            <div class="emp${compacto ? ' emp-min' : ''}">
                ${emp.logo ? `<img class="emp-logo" src="${esc(emp.logo)}" alt="">` : ''}
                <div>
                    <div class="emp-nome">${esc(empNome)}</div>
                    ${empSub ? `<div class="emp-sub">${esc(empSub)}</div>` : ''}
                    ${!compacto && empContato ? `<div class="emp-sub">${esc(empContato)}</div>` : ''}
                </div>
            </div>` : '';
        const pixBadge = `<span class="pixmark"><svg viewBox="0 0 32 32" width="14" height="14" aria-hidden="true"><path fill="#32BCAD" d="M16 2 30 16 16 30 2 16z"/><path fill="#fff" d="m11 11 5 5 5-5 3 3-8 8-8-8z" opacity=".92"/></svg>Pix</span>`;
        const pagadorLinhas = `${esc(paciente)}${cpfPag ? ` · CPF ${fmtCpf(cpfPag)}` : ''}${endPag ? `<br><span class="end">${esc(endPag)}</span>` : ''}`;

        // ---- CAPA ----
        const linhasTabela = rows.map(r => `
            <tr>
                <td>${r.parcela}/${r.parcelas_total}</td>
                <td>${dt(r.vencimento)}</td>
                <td class="num">${brl(r.valor_centavos)}</td>
                <td>${r.status === 'pago' ? `<span class="tag pago">Pago${r.pago_em ? ' ' + dt(r.pago_em) : ''}</span>` : `<span class="tag aberto">Em aberto</span>`}</td>
            </tr>`).join('');
        const capa = `
            <section class="capa parc" data-idx="capa">
                <button class="btn-uma no-print" onclick="imprimirUma('capa')" title="Imprimir só a capa">⎙ esta folha</button>
                ${cabecalhoEmpresa(false)}
                <div class="titulo">Carnê de pagamento</div>
                <div class="capa-meta">Referência ${planoRef} · Emitido em ${emissao}</div>
                <div class="cols">
                    <div class="campo"><span class="k">Beneficiário</span><span class="v">${esc(empNome || '—')}</span>${emp && emp.cnpj ? `<span class="end">CNPJ ${fmtCnpj(emp.cnpj)}</span>` : ''}</div>
                    <div class="campo"><span class="k">Pagador</span><span class="v">${pagadorLinhas}</span></div>
                </div>
                <div class="cols">
                    <div class="campo"><span class="k">Referente a</span><span class="v">${esc(descricao)}</span></div>
                    <div class="campo"><span class="k">Plano</span><span class="v">${nParc}× de ${brl(rows[0].valor_centavos)} · ${formaLbl}</span></div>
                    <div class="campo"><span class="k">1º vencimento</span><span class="v">${dt(primeiroVenc)}</span></div>
                    <div class="campo"><span class="k">Parcelas pagas</span><span class="v">${pagas} de ${rows.length}</span></div>
                </div>
                <table class="tab">
                    <thead><tr><th>Parcela</th><th>Vencimento</th><th class="num">Valor</th><th>Situação</th></tr></thead>
                    <tbody>${linhasTabela}</tbody>
                </table>
                <div class="resumo">
                    <div><span class="k">Total do plano</span><b>${brl(total)}</b></div>
                    <div><span class="k">Pago até aqui</span><b>${brl(totalPago)}</b></div>
                    <div class="saldo"><span class="k">Saldo devedor</span><b>${brl(saldo)}</b></div>
                </div>
                <div class="rodape">Documento de cobrança gerado por ${esc(empNome || 'sistema')}${emp && emp.cnpj ? ' — CNPJ ' + fmtCnpj(emp.cnpj) : ''} em ${emissao}. Em caso de dúvida, contate a clínica${emp && emp.telefone ? ' (' + esc(emp.telefone) + ')' : ''}.</div>
            </section>`;

        // ---- FICHAS (layout tipo boleto: cabeçalho + Beneficiário/Pagador + detalhamento + pagamento) ----
        const contatoEmp = emp ? [emp.telefone, emp.email].filter(Boolean).join(' / ') : '';
        const contatoPag = [telPag, emailPag].filter(Boolean).join(' / ');
        const blocos = [];
        let idx = 0;
        for (const r of rows) {
            const i = idx++;
            const isPix = r.psp_metodo === 'pix' && r.psp_qrcode;
            const isBol = r.psp_metodo === 'boleto';
            let pagoArea = '';
            if (isPix) {
                const img = r.psp_qrcode_img || await QRCode.toDataURL(r.psp_qrcode, { width: 340, margin: 1 }).catch(() => null);
                pagoArea = `<div class="pay">
                    ${img ? `<img class="qr" src="${img}" alt="QR Pix">` : ''}
                    <div class="pay-txt">
                        <div class="rot">${pixBadge} Copia e Cola — abra o app do banco, toque em Pix e cole o código:</div>
                        <div class="mono">${esc(r.psp_qrcode)}</div>
                        <div class="local">Pague via Pix por qualquer banco ou carteira digital.</div>
                    </div>
                </div>`;
            } else if (isBol) {
                pagoArea = `<div class="pay pay-col">
                    <div class="rot">Linha digitável</div>
                    <div class="mono big">${esc(r.psp_linha_digitavel || 'cobrança não gerada')}</div>
                    ${r.psp_url ? `<a class="link" href="${esc(r.psp_url)}">Abrir boleto oficial (PDF com código de barras)</a>` : ''}
                    <div class="local">Pagável em qualquer banco, lotérica ou app até o vencimento.</div>
                </div>`;
            } else {
                pagoArea = `<div class="aviso">Cobrança ainda não gerada para esta parcela. Gere o Pix/boleto no Financeiro e reemita o carnê.</div>`;
            }
            const pagoTag = r.status === 'pago' ? `<span class="tag pago">PAGO ${r.pago_em ? 'em ' + dt(r.pago_em) : ''}</span>` : `<span class="tag aberto">Em aberto</span>`;
            blocos.push(`
                <section class="parc doc" data-idx="${i}">
                    <button class="btn-uma no-print" onclick="imprimirUma(${i})" title="Imprimir só esta folha">⎙ esta folha</button>

                    <div class="doc-head">
                        ${emp && emp.logo ? `<img class="doc-logo" src="${esc(emp.logo)}" alt="">` : `<div class="doc-logo-txt">${esc(empNome || '')}</div>`}
                        <div class="doc-venc">
                            <div><span class="k">Vencimento</span><span class="vv">${dt(r.vencimento)}</span></div>
                            <div><span class="k">Valor</span><span class="vv val-red">${brl(r.valor_centavos)}</span></div>
                        </div>
                    </div>
                    <div class="doc-meta">Parcela ${r.parcela}/${r.parcelas_total} · Doc. nº ${docNum(r)} · Emissão ${emissao} · Data do documento ${dt(r.created_at)} · ${pagoTag}</div>

                    <div class="bp">
                        <div class="bp-col">
                            <div class="sec-h">Beneficiário</div>
                            <div class="bp-l"><b>Nome:</b> ${esc(empNome || '—')}</div>
                            ${emp && emp.cnpj ? `<div class="bp-l"><b>CPF/CNPJ:</b> ${fmtCnpj(emp.cnpj)}</div>` : ''}
                            ${emp && emp.endereco ? `<div class="bp-l"><b>Endereço:</b> ${esc(emp.endereco)}</div>` : ''}
                            ${contatoEmp ? `<div class="bp-l"><b>Contato:</b> ${esc(contatoEmp)}</div>` : ''}
                        </div>
                        <div class="bp-col">
                            <div class="sec-h">Pagador</div>
                            <div class="bp-l"><b>Nome:</b> ${esc(paciente)}</div>
                            ${cpfPag ? `<div class="bp-l"><b>CPF/CNPJ:</b> ${fmtCpf(cpfPag)}</div>` : ''}
                            ${endPag ? `<div class="bp-l"><b>Endereço:</b> ${esc(endPag)}</div>` : ''}
                            ${contatoPag ? `<div class="bp-l"><b>Contato:</b> ${esc(contatoPag)}</div>` : ''}
                        </div>
                    </div>

                    <div class="sec-h">Detalhamento <span>Valor</span></div>
                    <div class="det-l"><span>${esc(descricao)} — parcela ${r.parcela} de ${r.parcelas_total}</span><span class="num">${brl(r.valor_centavos)}</span></div>

                    <div class="sec-h">Forma de pagamento <span>Valor final</span></div>
                    <div class="det-l forma"><span>${isPix ? 'Pix' : isBol ? 'Boleto bancário' : (formaLbl || '—')}</span><span class="num big2">${brl(r.valor_centavos)}</span></div>

                    <div class="sec-h">Informações adicionais</div>
                    <div class="info">Após o vencimento, sujeito a multa e juros conforme contrato. Doc. nº ${docNum(r)}.</div>

                    <div class="corte"><span>&#9986; pague aqui</span></div>
                    ${pagoArea}

                    <div class="rodape">Documento de cobrança de ${esc(empNome || 'sistema')}${emp && emp.cnpj ? ' — CNPJ ' + fmtCnpj(emp.cnpj) : ''}, emitido em ${emissao}. Não substitui a nota fiscal. Dúvidas: contate a clínica${emp && emp.telefone ? ' (' + esc(emp.telefone) + ')' : ''}.</div>
                </section>`);
        }

        res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8"><title>Carnê ${esc(paciente)} — ${esc(descricao)}</title>
<style>
  * { box-sizing: border-box; }
  body { font: 14px/1.55 -apple-system, "Segoe UI", Roboto, Helvetica, sans-serif; color: #1a1a1a; margin: 0; background: #eef0f3; }
  .top { position: sticky; top: 0; z-index: 5; background: #fff; border-bottom: 1px solid #dcdce0; padding: 12px 20px; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .top h1 { font-size: 14px; font-weight: 600; margin: 0; color: #333; }
  .top button { font: inherit; font-weight: 600; padding: 9px 18px; border: 0; border-radius: 9px; background: #2563eb; color: #fff; cursor: pointer; }
  .wrap { max-width: 760px; margin: 24px auto 40px; padding: 0 16px; }

  .parc { position: relative; background: #fff; border: 1px solid #d8d8dd; border-radius: 14px; padding: 26px 28px 20px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,.05); }
  .btn-uma { position: absolute; top: 14px; right: 16px; font: inherit; font-size: 12px; padding: 5px 10px; border: 1px solid #d0d0d6; border-radius: 7px; background: #fafafa; color: #444; cursor: pointer; }
  .btn-uma:hover { background: #f0f0f2; }

  .emp { display: flex; align-items: center; gap: 14px; padding-bottom: 14px; border-bottom: 2px solid #1a1a1a; margin-bottom: 14px; }
  .emp.emp-min { padding-bottom: 10px; margin-bottom: 10px; border-bottom-width: 1px; }
  .emp-logo { max-height: 46px; max-width: 150px; object-fit: contain; }
  .emp.emp-min .emp-logo { max-height: 34px; }
  .emp-nome { font-size: 17px; font-weight: 800; letter-spacing: -.01em; }
  .emp.emp-min .emp-nome { font-size: 14px; }
  .emp-sub { font-size: 11.5px; color: #555; }

  .titulo { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #2563eb; margin-bottom: 4px; }
  .capa-meta { font-size: 11px; color: #888; margin-bottom: 16px; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 24px; margin-bottom: 14px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 24px; margin-bottom: 12px; }
  .campo { display: flex; flex-direction: column; gap: 2px; }
  .k { font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: #888; }
  .v { font-size: 14px; font-weight: 600; }
  .end { font-size: 11px; color: #666; font-weight: 400; }
  .local { font-size: 11.5px; color: #555; margin-bottom: 12px; }
  .tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 2px 9px; border-radius: 999px; }
  .tag.pago { background: #dcfce7; color: #15803d; }
  .tag.aberto { background: #fef9c3; color: #a16207; }

  .tab { width: 100%; border-collapse: collapse; margin: 6px 0 16px; font-size: 12.5px; }
  .tab th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #888; border-bottom: 1.5px solid #333; padding: 6px 8px; }
  .tab td { padding: 6px 8px; border-bottom: 1px solid #eee; }
  .tab .num, .tab th.num { text-align: right; font-variant-numeric: tabular-nums; }

  .resumo { display: flex; gap: 10px; }
  .resumo > div { flex: 1; background: #f7f8fa; border: 1px solid #e6e6ea; border-radius: 9px; padding: 10px 12px; display: flex; flex-direction: column; gap: 2px; }
  .resumo b { font-size: 16px; }
  .resumo .saldo { background: #eef4ff; border-color: #cfe0ff; }
  .resumo .saldo b { color: #1d4ed8; }

  .valor-box { display: flex; justify-content: space-between; align-items: center; background: #f7f8fa; border: 1px solid #e6e6ea; border-radius: 10px; padding: 12px 18px; margin-bottom: 18px; }
  .valor { font-size: 26px; font-weight: 800; letter-spacing: -.02em; }

  .canhoto { border: 1px dashed #b9b9c0; border-radius: 8px; padding: 10px 14px; }
  .canhoto-t { font-size: 9.5px; text-transform: uppercase; letter-spacing: .08em; color: #999; margin-bottom: 6px; }
  .canhoto-g { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px 16px; font-size: 11.5px; }
  .corte { text-align: center; color: #9a9aa2; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; margin: 18px 0 14px; border-top: 1.5px dashed #b9b9c0; }
  .corte span { display: inline-block; background: #fff; padding: 0 10px; transform: translateY(-50%); }

  /* Layout "boleto" da ficha */
  .doc-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding-bottom: 14px; border-bottom: 1px solid #e2e2e6; margin-bottom: 4px; }
  .doc-logo { max-height: 44px; max-width: 170px; object-fit: contain; }
  .doc-logo-txt { font-size: 18px; font-weight: 800; }
  .doc-venc { display: flex; gap: 22px; text-align: right; }
  .doc-venc > div { display: flex; flex-direction: column; gap: 1px; }
  .doc-venc .vv { font-size: 15px; font-weight: 700; }
  .val-red { color: #dc2626; font-size: 18px !important; }
  .doc-meta { font-size: 10.5px; color: #888; margin-bottom: 14px; }
  .bp { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 6px; }
  .bp-l { font-size: 12.5px; margin: 3px 0; }
  .bp-l b { font-weight: 600; color: #555; }
  .sec-h { display: flex; justify-content: space-between; align-items: center; background: #eef0f3; font-weight: 700; font-size: 13px; padding: 7px 12px; border-radius: 4px; margin: 16px 0 8px; }
  .sec-h span { font-weight: 600; font-size: 11px; color: #666; }
  .det-l { display: flex; justify-content: space-between; align-items: center; padding: 4px 12px; font-size: 13px; }
  .det-l .num { font-variant-numeric: tabular-nums; }
  .det-l.forma { border-top: 1px solid #eee; padding-top: 10px; margin-top: 2px; }
  .big2 { font-size: 20px; font-weight: 800; }
  .info { font-size: 12px; color: #555; padding: 2px 12px 4px; }

  .pixmark { display: inline-flex; align-items: center; gap: 4px; font-weight: 700; color: #0b7a6e; }
  .pixmark svg { vertical-align: middle; }

  .pay { display: flex; gap: 20px; align-items: flex-start; }
  .pay-col { flex-direction: column; align-items: stretch; }
  .qr { width: 190px; height: 190px; flex-shrink: 0; border: 1px solid #e6e6ea; border-radius: 8px; }
  .pay-txt { min-width: 0; flex: 1; }
  .rot { font-size: 11px; color: #666; margin-bottom: 6px; }
  .mono { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 11px; word-break: break-all; background: #f6f6f8; border: 1px dashed #c9c9cf; border-radius: 7px; padding: 10px; }
  .mono.big { font-size: 15px; letter-spacing: .02em; text-align: center; word-break: break-all; }
  .link { display: inline-block; margin-top: 8px; font-size: 12.5px; color: #2563eb; text-decoration: none; font-weight: 600; }
  .aviso { color: #92400e; background: #fef3c7; border: 1px solid #fde68a; border-radius: 8px; padding: 12px; font-size: 13px; }
  .rodape { margin-top: 18px; padding-top: 12px; border-top: 1px solid #eee; font-size: 10.5px; color: #999; }

  @media print {
    body { background: #fff; }
    .top, .no-print { display: none !important; }
    .wrap { margin: 0; max-width: none; padding: 0; }
    .parc { border: 0; border-radius: 0; box-shadow: none; margin: 0; padding: 18mm 16mm; page-break-after: always; }
    .parc:last-child { page-break-after: auto; }
    .qr { width: 44mm; height: 44mm; }
  }
</style></head><body>
<div class="top">
  <h1>${esc(paciente)} · ${esc(descricao)} · ${pagas}/${rows.length} pagas · total ${brl(total)}</h1>
  <button onclick="window.print()">Imprimir tudo / Salvar PDF</button>
</div>
<div class="wrap">${capa}${blocos.join('')}</div>
<script>
  function imprimirUma(alvo){
    var secs = document.querySelectorAll('.parc');
    secs.forEach(function(el){ el.style.display = (String(el.dataset.idx) === String(alvo) ? '' : 'none'); });
    window.print();
  }
  window.addEventListener('afterprint', function(){
    document.querySelectorAll('.parc').forEach(function(el){ el.style.display = ''; });
  });
</script>
</body></html>`);
    } catch (e) {
        console.error('[carne]', e.message);
        res.status(500).send('Erro ao montar o carnê.');
    }
});

// Webhook do PSP (rota pública). Marca a parcela como paga quando o dinheiro
// entra. Sempre responde 200 pro PSP não ficar reenviando.
app.post('/api/webhooks/psp', async (req, res) => {
    try {
        const ev = await pspParseWebhook(req);
        if (!ev || !ev.chargeId) return res.json({ ok: true, ignored: true });

        const rows = await queryD1('SELECT * FROM crm_pagamentos WHERE psp_charge_id = ? LIMIT 1', [ev.chargeId]);
        const pg = rows && rows[0];
        if (!pg) return res.json({ ok: true, unknown: true });

        if (ev.status === 'pago' && pg.status !== 'pago') {
            await queryD1(
                "UPDATE crm_pagamentos SET status = 'pago', pago_em = ?, psp_status = 'pago' WHERE id = ?",
                [ev.pagoEm || todayISO(), pg.id]
            );
            if (pg.lead_id) {
                // A confirmação veio de fonte externa e confiável — reflete no card.
                markLeadPagDirty(pg.lead_id);
                await syncLeadPagamento(pg.lead_id, 'psp-webhook').catch(() => {});
                broadcastLeadsUpdate('updated', pg.lead_id);
            }
            console.log(`[psp] parcela ${pg.id} paga via webhook (${ev.chargeId}).`);
        } else if (ev.status === 'cancelado') {
            await queryD1("UPDATE crm_pagamentos SET psp_status = 'cancelado' WHERE id = ?", [pg.id]);
        }
        res.json({ ok: true });
    } catch (e) {
        console.warn('[psp] webhook:', e.message);
        // 200 mesmo em erro de assinatura — logamos e seguimos; retry do PSP não ajuda.
        res.json({ ok: false, error: e.message });
    }
});

// Contas a receber: pendentes agrupados por faixa de atraso/vencimento (aging).
app.get('/api/contas-a-receber', async (req, res) => {
    try {
        const rows = await queryD1(
            "SELECT * FROM crm_pagamentos WHERE tipo = 'recebimento' AND status = 'pendente' ORDER BY COALESCE(vencimento, '9999-12-31') ASC, id ASC"
        );
        const hoje = todayISO();
        const buckets = { vencido: 0, hoje: 0, d1_7: 0, d8_30: 0, d30_mais: 0, sem_venc: 0 };
        let total = 0, totalVencido = 0;

        const itens = rows.map(r => {
            const c = Number(r.valor_centavos) || 0;
            total += c;
            let bucket;
            if (!r.vencimento) bucket = 'sem_venc';
            else if (r.vencimento < hoje) { bucket = 'vencido'; totalVencido += c; }
            else if (r.vencimento === hoje) bucket = 'hoje';
            else {
                const dias = Math.ceil((Date.parse(r.vencimento) - Date.parse(hoje)) / 86400000);
                bucket = dias <= 7 ? 'd1_7' : dias <= 30 ? 'd8_30' : 'd30_mais';
            }
            buckets[bucket] += c;
            const diasAtraso = (r.vencimento && r.vencimento < hoje)
                ? Math.floor((Date.parse(hoje) - Date.parse(r.vencimento)) / 86400000) : 0;
            return { ...fmtPagamento(r), bucket, dias_atraso: diasAtraso };
        });

        const toBRL = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, centsToBRL(v)]));
        res.json({
            total_centavos: total, total: centsToBRL(total),
            vencido_centavos: totalVencido, vencido: centsToBRL(totalVencido),
            buckets_centavos: buckets, buckets: toBRL(buckets),
            itens,
        });
    } catch (e) {
        console.error('Erro em contas a receber:', e);
        res.status(500).json({ error: e.message || 'Erro interno.' });
    }
});

// Resumo enxuto pra faixa de KPIs: recebido no período (caixa), a receber e vencido.
app.get('/api/financeiro/resumo', async (req, res) => {
    try {
        const hoje = todayISO();
        const start = req.query.start || (hoje.slice(0, 8) + '01');
        const end = req.query.end || hoje;
        const rows = await queryD1('SELECT valor_centavos, tipo, status, pago_em, vencimento FROM crm_pagamentos');

        let recebido = 0, aReceber = 0, vencido = 0;
        for (const r of rows) {
            const c = Number(r.valor_centavos) || 0;
            if (r.status === 'pago' && r.pago_em && r.pago_em >= start && r.pago_em <= end) recebido += c;
            if (r.status === 'pendente' && r.tipo === 'recebimento') {
                aReceber += c;
                if (r.vencimento && r.vencimento < hoje) vencido += c;
            }
        }
        res.json({
            periodo: { start, end },
            recebido_centavos: recebido, recebido: centsToBRL(recebido),
            a_receber_centavos: aReceber, a_receber: centsToBRL(aReceber),
            vencido_centavos: vencido, vencido: centsToBRL(vencido),
        });
    } catch (e) {
        console.error('Erro no resumo financeiro:', e);
        res.status(500).json({ error: e.message || 'Erro interno.' });
    }
});

// Contador enxuto de parcelas vencidas — pro badge da aba Financeiro.
// Agregado com WHERE que casa com idx_pag_status_venc: lê só as linhas vencidas.
app.get('/api/financeiro/vencido', async (req, res) => {
    try {
        const hoje = todayISO();
        const rows = await queryD1(
            `SELECT COUNT(*) AS n, COALESCE(SUM(valor_centavos), 0) AS c
               FROM crm_pagamentos
              WHERE status = 'pendente' AND tipo = 'recebimento'
                AND vencimento IS NOT NULL AND vencimento < ?`,
            [hoje]
        );
        const r = rows && rows[0] || {};
        const count = Number(r.n) || 0;
        const cents = Number(r.c) || 0;
        res.json({ count, total_centavos: cents, total: centsToBRL(cents) });
    } catch (e) {
        console.error('Erro no contador de vencidos:', e);
        res.status(500).json({ error: e.message || 'Erro interno.' });
    }
});

// Reprocessa o espelho Kanban -> crm_pagamentos de todos os leads com valor.
// Em lotes (offset), porque o backfill do boot não roda inteiro no serverless
// e um loop único estouraria o timeout da função. O front chama em sequência
// até done=true.
app.post('/api/financeiro/sync-kanban', async (req, res) => {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradores podem sincronizar.' });
    }
    try {
        const limit = Math.min(300, parseInt(req.query.limit, 10) || 120);
        const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
        const leads = await queryD1(
            `SELECT id FROM leads
             WHERE (valor_recebido IS NOT NULL AND valor_recebido > 0)
                OR (orcamento IS NOT NULL AND orcamento NOT IN ('', '[]', '{}'))
             ORDER BY id LIMIT ? OFFSET ?`,
            [limit, offset]
        );
        for (const l of leads) await syncLeadPagamento(l.id);
        res.json({
            sincronizados: leads.length,
            next_offset: offset + leads.length,
            done: leads.length < limit,
        });
    } catch (e) {
        console.error('Erro no sync-kanban:', e);
        res.status(500).json({ error: e.message || 'Erro interno.' });
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

        // Mesmo critério da tela: só os agendamentos deste sistema, salvo only_local=0.
        const onlyLocal = req.query.only_local !== '0';
        const rows = await getMergedAgendamentos(startDate, endDate, { onlyLocal });

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

        // A API do Amigo não devolve um ID estável pro aniversariante (diferente de
        // /api/relacionamento, que tem patient.id) — usamos o telefone como chave de
        // "já contactado" em mensagens_enviadas, já que é o único identificador comum
        // entre esse bloco (API ao vivo) e o bloco do mês (planilha).
        try {
            const rows = await queryD1("SELECT paciente_id FROM mensagens_enviadas WHERE tipo = 'aniversariante' AND data_envio > datetime('now', '-30 days')");
            const contactedPhones = new Set(rows.map(r => r.paciente_id));
            found = found.map(p => ({ ...p, contacted: contactedPhones.has(p.phone) }));
        } catch (e) {
            console.error("D1: Não foi possível carregar histórico de aniversariantes contactados", e.message);
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

        // Mesma chave por telefone usada em /api/aniversariantes (API ao vivo) — sem ID
        // estável comum entre os dois blocos, o telefone é o que garante que marcar como
        // contactado num bloco reflita no outro pro mesmo aniversariante.
        try {
            const contactedRows = await queryD1("SELECT paciente_id FROM mensagens_enviadas WHERE tipo = 'aniversariante' AND data_envio > datetime('now', '-30 days')");
            const contactedPhones = new Set(contactedRows.map(r => r.paciente_id));
            found = found.map(p => ({ ...p, contacted: contactedPhones.has(p.phone) }));
        } catch (e) {
            console.error("D1: Não foi possível carregar histórico de aniversariantes contactados", e.message);
        }

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
                    sendPushToAll('Atendimento finalizado', msg).catch(() => {});
                }
            }
        } catch (e) {
            console.error("Erro no radar de notificações:", e.message);
        }
    }, 5 * 60 * 1000);
}

// ==========================================
// MOTOR DE FLUXO DE ATENDIMENTO (nodes)
// ==========================================
// Um "fluxo" é um grafo de passos percorrido por lead quando chega uma mensagem
// de WhatsApp. Roda ANTES do agente de IA (webhook -> flowDispatchInbound): se um
// fluxo assume a conversa, a IA não responde aquele turno. Esperas e timeouts são
// resolvidos pelo endpoint /api/flows/tick (agendado via Vercel Cron).

const FLOW_MAX_STEPS = 40;

// "Lead WhatsApp"/"Contato" não são nomes de gente — são o texto que o
// próprio sistema grava quando o WhatsApp não manda o nome de perfil do
// contato. Sem esse filtro, {{nome}} em follow-up/fluxo virava literalmente
// "Oi Lead WhatsApp, ...". Sempre primeiro nome só — fica mais natural.
const LEAD_NOME_PLACEHOLDER_RE = /^(lead\s*whatsapp|contato|lead|desconhecido)$/i;
function safeLeadFirstName(nome) {
    const n = String(nome || '').trim();
    if (!n || LEAD_NOME_PLACEHOLDER_RE.test(n)) return '';
    return n.split(/\s+/)[0];
}

function flowInterpolate(text, ctx) {
    const raw = String(text == null ? '' : text).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
        const v = (k === 'nome') ? safeLeadFirstName(ctx[k]) : ctx[k];
        return (v === undefined || v === null) ? '' : String(v);
    });
    // Sem nome, {{nome}} vira '' e sobra pontuação órfã ("Oi , você chegou",
    // "{{nome}}, ainda..." -> ", ainda..."). Limpa e recapitaliza o início.
    return raw
        .replace(/\s+,/g, ',')
        .replace(/,\s*,/g, ',')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[,!]\s*/, '')
        .replace(/^([a-zà-ÿ])/i, (m) => m.toUpperCase())
        .trim();
}

function flowDbTime(msFromNow = 0) {
    return new Date(Date.now() + msFromNow).toISOString().slice(0, 19).replace('T', ' ');
}

// Executa UM node. Retorna a instrução de transição:
//   { go: 'n3' }                            -> vai pro node n3
//   { wait: true, timeoutMin, timeoutGo }   -> pausa aguardando resposta do lead
//   { sleep: minutos }                      -> pausa por tempo
//   { end: true, handoffToAi }              -> encerra a run
async function flowExecNode(node, run, ctx, opts) {
    const cfg = node.config || {};
    const sim = !!opts.simulate;
    const logAcao = (extra) => { if (opts.log) opts.log.push(Object.assign({ node: node.id, tipo: node.type }, extra || {})); };

    switch (node.type) {
        case 'enviar_texto': {
            const texto = flowInterpolate(cfg.texto, ctx);
            logAcao({ texto });
            if (!sim && texto.trim()) await sendWhatsappTextInternal(run.phone, texto, 'fluxo');
            return { go: node.next || null };
        }
        case 'enviar_audio': {
            logAcao({ voice_id: cfg.voice_id || null });
            if (!sim && cfg.voice_id) {
                try {
                    const rows = await queryD1('SELECT nome, audio_base64 FROM crm_voice_library WHERE id = ?', [cfg.voice_id]);
                    if (rows && rows[0] && rows[0].audio_base64) {
                        await sendWhatsappAudioInternal(run.phone, Buffer.from(rows[0].audio_base64, 'base64'), (rows[0].nome || 'audio') + '.ogg', 'fluxo');
                    }
                } catch (e) { console.error('Fluxo enviar_audio falhou:', e.message); }
            }
            return { go: node.next || null };
        }
        case 'aguardar_resposta': {
            logAcao({ timeout_min: cfg.timeout_min || null });
            return { wait: true, timeoutMin: Number(cfg.timeout_min) || null, timeoutGo: node.on_timeout || null };
        }
        case 'delay': {
            const mins = Math.max(1, Number(cfg.minutos) || 1);
            logAcao({ minutos: mins });
            return { sleep: mins };
        }
        case 'condicao': {
            const resp = String(ctx.ultima_resposta || '');
            const alvo = String(cfg.valor || '');
            const modo = cfg.modo || 'contem';
            let hit = false;
            if (modo === 'igual') hit = resp.trim().toLowerCase() === alvo.trim().toLowerCase();
            else if (modo === 'comeca_com') hit = resp.trim().toLowerCase().startsWith(alvo.trim().toLowerCase());
            else if (modo === 'regex') { try { hit = new RegExp(alvo, 'i').test(resp); } catch (e) { hit = false; } }
            else hit = resp.toLowerCase().includes(alvo.toLowerCase());
            logAcao({ modo, valor: alvo, resultado: hit });
            return { go: (hit ? node.on_true : node.on_false) || null };
        }
        case 'mover_coluna': {
            logAcao({ coluna: cfg.coluna });
            if (!sim && cfg.coluna) await queryD1('UPDATE leads SET column_id = ? WHERE id = ?', [cfg.coluna, run.lead_id]);
            return { go: node.next || null };
        }
        case 'adicionar_tag': {
            logAcao({ tag: cfg.tag });
            if (!sim && cfg.tag) {
                const rows = await queryD1('SELECT tags FROM leads WHERE id = ?', [run.lead_id]);
                const atual = (rows && rows[0] && rows[0].tags) ? String(rows[0].tags).split(',').map(s => s.trim()).filter(Boolean) : [];
                if (!atual.includes(cfg.tag)) {
                    atual.push(cfg.tag);
                    await queryD1('UPDATE leads SET tags = ? WHERE id = ?', [atual.join(','), run.lead_id]);
                }
            }
            return { go: node.next || null };
        }
        case 'definir_ia': {
            const on = cfg.ligada ? 1 : 0;
            logAcao({ ia_ligada: on });
            if (!sim) await queryD1('UPDATE leads SET ai_enabled = ? WHERE id = ?', [on, run.lead_id]);
            return { go: node.next || null };
        }
        case 'entregar_ia': {
            logAcao({});
            if (!sim) await queryD1('UPDATE leads SET ai_enabled = 1 WHERE id = ?', [run.lead_id]);
            return { end: true, handoffToAi: true };
        }
        case 'handoff': {
            const motivo = flowInterpolate(cfg.motivo, ctx) || 'Lead pronto para atendimento humano';
            logAcao({ motivo });
            if (!sim) {
                await queryD1('UPDATE leads SET ai_enabled = 0 WHERE id = ?', [run.lead_id]);
                const handoffMsg = `🤝 Fluxo de atendimento: ${motivo} — ${ctx.nome || run.phone}`;
                try {
                    await queryD1('INSERT INTO crm_notifications (id, message, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
                        [`flow-${run.id}-${Date.now()}`, handoffMsg]);
                    sendPushToAll('Fluxo pediu atendimento humano', handoffMsg, { phone: run.phone }).catch(() => {});
                } catch (e) {}
            }
            return { end: true };
        }
        case 'fim':
        default: {
            logAcao({});
            return { end: true };
        }
    }
}

// Percorre a run a partir de _startNodeId (ou current_node_id) até parar/pausar.
async function flowRun(run, graph, ctx, opts = {}) {
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    let nodeId = run._startNodeId != null ? run._startNodeId : run.current_node_id;
    let steps = Number(run.steps_done) || 0;
    const persist = !opts.simulate;

    while (nodeId && steps < FLOW_MAX_STEPS) {
        const node = nodes.find(n => n.id === nodeId);
        if (!node) { nodeId = null; break; }

        const r = await flowExecNode(node, run, ctx, opts);
        steps++;
        run._lastNode = node.id;

        if (r.sleep) {
            if (opts.simulate) { nodeId = node.next || null; continue; }
            await queryD1(
                'UPDATE crm_flow_runs SET status = ?, current_node_id = ?, context_json = ?, steps_done = ?, next_wake_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                ['sleeping', node.id, JSON.stringify(ctx), steps, flowDbTime(r.sleep * 60000), run.id]);
            return { status: 'sleeping' };
        }
        if (r.wait) {
            if (persist) {
                await queryD1(
                    'UPDATE crm_flow_runs SET status = ?, current_node_id = ?, context_json = ?, steps_done = ?, next_wake_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                    ['waiting_reply', node.id, JSON.stringify(ctx), steps, r.timeoutMin ? flowDbTime(r.timeoutMin * 60000) : null, run.id]);
            }
            return { status: 'waiting_reply' };
        }
        if (r.end) {
            if (persist) {
                await queryD1(
                    'UPDATE crm_flow_runs SET status = ?, current_node_id = ?, context_json = ?, steps_done = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                    ['done', node.id, JSON.stringify(ctx), steps, run.id]);
            }
            return { status: 'done', handoffToAi: !!r.handoffToAi };
        }
        nodeId = r.go || null;
    }

    if (persist) {
        await queryD1('UPDATE crm_flow_runs SET status = ?, steps_done = ?, context_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            ['done', steps, JSON.stringify(ctx), run.id]);
    }
    if (opts.log && steps >= FLOW_MAX_STEPS) opts.log.push({ aviso: 'limite de passos atingido — fluxo encerrado' });
    return { status: 'done' };
}

async function flowFindTrigger(lead, phone, msgBody) {
    const rows = await queryD1("SELECT * FROM crm_flows WHERE ativo = 1 ORDER BY prioridade DESC, updated_at DESC");
    if (!rows || !rows.length) return null;
    const variants = phoneVariants(phone);
    const ph = variants.map(() => '?').join(', ');
    let inboundCount = null;

    for (const f of rows) {
        let g;
        try { g = JSON.parse(f.graph_json || '{}'); } catch (e) { continue; }
        if (!Array.isArray(g.nodes) || !g.nodes.length) continue;
        const t = g.trigger || {};
        const cfg = t.config || {};

        if (t.type === 'primeira_mensagem') {
            if (inboundCount == null) {
                const c = await queryD1(`SELECT COUNT(*) AS c FROM wa_messages WHERE direction = 'in' AND phone IN (${ph})`, variants);
                inboundCount = (c && c[0]) ? Number(c[0].c) : 0;
            }
            if (inboundCount <= 1) return { flow: f, graph: g };
        } else if (t.type === 'entrou_coluna') {
            if (lead.column_id === cfg.coluna) return { flow: f, graph: g };
        } else if (t.type === 'palavra_chave') {
            const kws = String(cfg.palavras || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
            if (kws.length && kws.some(k => String(msgBody || '').toLowerCase().includes(k))) return { flow: f, graph: g };
        }
    }
    return null;
}

// Chamado pelo webhook. Retorna true se um fluxo assumiu a mensagem (a IA não responde).
async function flowDispatchInbound(leadId, phone, msgBody) {
    const variants = phoneVariants(phone);
    const ph = variants.map(() => '?').join(', ');

    const leadRows = await queryD1('SELECT * FROM leads WHERE id = ?', [leadId]);
    const lead = leadRows && leadRows[0];
    if (!lead) return false;

    // 1) Existe run aguardando resposta pra esse número?
    const activeRows = await queryD1(
        `SELECT * FROM crm_flow_runs WHERE status = 'waiting_reply' AND phone IN (${ph}) ORDER BY updated_at DESC LIMIT 1`, variants);
    if (activeRows && activeRows[0]) {
        const run = activeRows[0];
        const fr = await queryD1('SELECT * FROM crm_flows WHERE id = ?', [run.flow_id]);
        if (!fr || !fr[0]) { await queryD1("UPDATE crm_flow_runs SET status = 'failed' WHERE id = ?", [run.id]); return false; }
        let graph; try { graph = JSON.parse(fr[0].graph_json || '{}'); } catch (e) { return false; }
        let ctx = {}; try { ctx = JSON.parse(run.context_json || '{}'); } catch (e) {}
        ctx.ultima_resposta = msgBody;
        ctx.nome = lead.nome || '';
        ctx.telefone = lead.telefone || '';
        const waitNode = (graph.nodes || []).find(n => n.id === run.current_node_id);
        run._startNodeId = waitNode ? (waitNode.next || null) : null;
        run.lead_id = leadId;
        run.phone = lead.telefone || phone;
        await queryD1("UPDATE crm_flow_runs SET status = 'running' WHERE id = ?", [run.id]);
        const res = await flowRun(run, graph, ctx, {});
        return !res.handoffToAi;
    }

    // 2) Algum gatilho casa? (e esse fluxo ainda não rodou pra esse lead)
    const trig = await flowFindTrigger(lead, phone, msgBody);
    if (!trig) return false;
    const prior = await queryD1("SELECT id FROM crm_flow_runs WHERE flow_id = ? AND lead_id = ? AND status != 'failed' LIMIT 1", [trig.flow.id, leadId]);
    if (prior && prior[0]) return false;

    const startNode = trig.graph.nodes.find(n => n.id === trig.graph.start) || trig.graph.nodes[0];
    if (!startNode) return false;
    const runId = 'fr-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const ctx = { nome: lead.nome || '', telefone: lead.telefone || '', ultima_resposta: msgBody, gatilho_msg: msgBody };
    await queryD1(
        'INSERT INTO crm_flow_runs (id, flow_id, flow_version, lead_id, phone, status, current_node_id, context_json, steps_done) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)',
        [runId, trig.flow.id, trig.flow.version || 1, leadId, lead.telefone || phone, 'running', startNode.id, JSON.stringify(ctx)]);
    const run = { id: runId, flow_id: trig.flow.id, lead_id: leadId, phone: lead.telefone || phone, current_node_id: startNode.id, steps_done: 0, _startNodeId: startNode.id };
    const res = await flowRun(run, trig.graph, ctx, {});
    return !res.handoffToAi;
}

function flowRequireAdmin(req, res) {
    if (!req.user || req.user.role !== 'admin') { res.status(403).json({ error: 'Apenas administradores editam fluxos.' }); return false; }
    return true;
}

app.get('/api/flows', async (req, res) => {
    try {
        const rows = await queryD1('SELECT id, nome, ativo, prioridade, version, updated_at FROM crm_flows ORDER BY updated_at DESC');
        res.json({ flows: rows || [] });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno.' }); }
});

app.get('/api/flows/:id', async (req, res) => {
    try {
        const rows = await queryD1('SELECT * FROM crm_flows WHERE id = ?', [req.params.id]);
        if (!rows || !rows[0]) return res.status(404).json({ error: 'Fluxo não encontrado.' });
        res.json({ flow: rows[0] });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno.' }); }
});

app.post('/api/flows', async (req, res) => {
    if (!flowRequireAdmin(req, res)) return;
    try {
        const id = 'flow-' + Date.now().toString(36);
        const nome = (String(req.body.nome || '').trim().slice(0, 120)) || 'Novo fluxo';
        const graph = JSON.stringify(req.body.graph || { trigger: { type: 'primeira_mensagem', config: {} }, nodes: [] });
        await queryD1('INSERT INTO crm_flows (id, nome, ativo, prioridade, graph_json, version) VALUES (?, ?, 0, 0, ?, 1)', [id, nome, graph]);
        res.status(201).json({ id });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno.' }); }
});

app.put('/api/flows/:id', async (req, res) => {
    if (!flowRequireAdmin(req, res)) return;
    try {
        const rows = await queryD1('SELECT * FROM crm_flows WHERE id = ?', [req.params.id]);
        if (!rows || !rows[0]) return res.status(404).json({ error: 'Fluxo não encontrado.' });
        const cur = rows[0];
        const nome = req.body.nome != null ? String(req.body.nome).trim().slice(0, 120) : cur.nome;
        const ativo = req.body.ativo != null ? (req.body.ativo ? 1 : 0) : cur.ativo;
        const prioridade = req.body.prioridade != null ? (parseInt(req.body.prioridade, 10) || 0) : cur.prioridade;
        let graph_json = cur.graph_json;
        let version = cur.version || 1;
        if (req.body.graph !== undefined) {
            graph_json = JSON.stringify(req.body.graph);
            if (graph_json !== cur.graph_json) version += 1;
        }
        await queryD1('UPDATE crm_flows SET nome = ?, ativo = ?, prioridade = ?, graph_json = ?, version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [nome, ativo, prioridade, graph_json, version, req.params.id]);
        res.json({ success: true, version });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno.' }); }
});

app.delete('/api/flows/:id', async (req, res) => {
    if (!flowRequireAdmin(req, res)) return;
    try {
        await queryD1('DELETE FROM crm_flows WHERE id = ?', [req.params.id]);
        await queryD1("UPDATE crm_flow_runs SET status = 'failed' WHERE flow_id = ? AND status IN ('running','waiting_reply','sleeping')", [req.params.id]);
        res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno.' }); }
});

app.get('/api/flows/:id/runs', async (req, res) => {
    try {
        const rows = await queryD1(
            "SELECT r.id, r.lead_id, r.phone, r.status, r.current_node_id, r.updated_at, l.nome AS lead_nome FROM crm_flow_runs r LEFT JOIN leads l ON l.id = r.lead_id WHERE r.flow_id = ? ORDER BY r.updated_at DESC LIMIT 30",
            [req.params.id]);
        res.json({ runs: rows || [] });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno.' }); }
});

// Simulação: roda o grafo em memória, sem gravar nada nem enviar WhatsApp.
app.post('/api/flows/simulate', async (req, res) => {
    try {
        const graph = req.body.graph;
        const messages = Array.isArray(req.body.messages) ? req.body.messages.map(String) : [];
        if (!graph || !Array.isArray(graph.nodes) || !graph.nodes.length) return res.status(400).json({ error: 'Fluxo sem passos.' });
        const log = [];
        const ctx = { nome: req.body.nome || 'Paciente Teste', telefone: '5561999990000', ultima_resposta: messages[0] || '', gatilho_msg: messages[0] || '' };
        const fakeRun = { id: 'sim', lead_id: 'sim', phone: 'sim', steps_done: 0 };
        let startId = (graph.nodes.find(n => n.id === graph.start) || graph.nodes[0]).id;
        let msgIdx = 0;
        let guard = 0;
        while (startId && guard++ < 80) {
            fakeRun._startNodeId = startId;
            fakeRun.steps_done = 0;
            const r = await flowRun(fakeRun, graph, ctx, { simulate: true, log });
            if (r.status !== 'waiting_reply') break;
            msgIdx++;
            if (msgIdx >= messages.length) { log.push({ info: 'aguardando resposta do paciente (sem mais mensagens de teste)' }); break; }
            ctx.ultima_resposta = messages[msgIdx];
            log.push({ info: `paciente responde: "${messages[msgIdx]}"` });
            const waitNode = graph.nodes.find(n => n.id === fakeRun._lastNode);
            startId = waitNode ? (waitNode.next || null) : null;
        }
        res.json({ log });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Erro na simulação.' }); }
});

// Tick: resolve esperas/timeouts vencidos. Chamado pelo Vercel Cron (Authorization:
// Bearer CRON_SECRET) ou por um usuário logado ("processar agora" na UI).
// Fora do prefixo /api/flows/:id de propósito, pra não colidir com o route param.
app.all('/api/flow-tick', async (req, res) => {
    const authed = (() => {
        try {
            if (req.cookies && req.cookies.crm_token) { jwt.verify(req.cookies.crm_token, process.env.JWT_SECRET); return true; }
        } catch (e) {}
        const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
        if (process.env.CRON_SECRET && bearer && bearer === process.env.CRON_SECRET) return true;
        if (process.env.FLOW_TICK_SECRET && req.query.key === process.env.FLOW_TICK_SECRET) return true;
        return false;
    })();
    if (!authed) return res.status(401).json({ error: 'Não autorizado.' });

    try {
        const now = flowDbTime();

        // Heartbeat: guarda quando o tick rodou. Abrir /api/flow-tick logado mostra
        // "prev_run" = quando foi a última execução — se for ~1 min atrás, o pinger
        // externo está vivo; se for null / horas atrás, o pinger parou.
        let prevRun = null;
        try {
            const pr = await queryD1("SELECT value FROM crm_settings WHERE key = 'flow_tick_last_run'");
            prevRun = pr && pr[0] ? pr[0].value : null;
        } catch (e) {}
        queryD1("INSERT INTO crm_settings (key, value) VALUES ('flow_tick_last_run', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [now]).catch(() => {});
        const prevRunAgoSec = prevRun ? Math.round((Date.now() - (followupParseTs(prevRun)?.getTime() || Date.now())) / 1000) : null;

        const due = await queryD1(
            "SELECT * FROM crm_flow_runs WHERE status IN ('sleeping','waiting_reply') AND next_wake_at IS NOT NULL AND next_wake_at <= ? ORDER BY next_wake_at ASC LIMIT 25", [now]);
        let processed = 0;
        for (const run of (due || [])) {
            const fr = await queryD1('SELECT * FROM crm_flows WHERE id = ?', [run.flow_id]);
            if (!fr || !fr[0]) { await queryD1("UPDATE crm_flow_runs SET status = 'failed' WHERE id = ?", [run.id]); continue; }
            let graph; try { graph = JSON.parse(fr[0].graph_json || '{}'); } catch (e) { continue; }
            let ctx = {}; try { ctx = JSON.parse(run.context_json || '{}'); } catch (e) {}
            const node = (graph.nodes || []).find(n => n.id === run.current_node_id);
            if (!node) { await queryD1("UPDATE crm_flow_runs SET status = 'done' WHERE id = ?", [run.id]); continue; }
            run._startNodeId = run.status === 'sleeping' ? (node.next || null) : (node.on_timeout || null);
            await queryD1("UPDATE crm_flow_runs SET status = 'running' WHERE id = ?", [run.id]);
            await flowRun(run, graph, ctx, {});
            processed++;
        }

        let followup = { opened: 0, processed: 0 };
        try { followup = await followupTick(); } catch (e) { console.error('Erro no follow-up tick:', e); }

        // Detector de oportunidades — tem cadência própria por dentro (só roda a
        // varredura cara a cada opps_config.intervalo_horas), então pode ser
        // chamado em todo tick sem custo.
        let opps = { skipped: 'erro' };
        try { opps = await opportunitiesTick(); } catch (e) { console.error('Erro no detector de oportunidades:', e); }

        // Digest do Agente de IA — mesma lógica de cadência própria (só reprocessa
        // a cada ai_insights_config.intervalo_horas).
        let insights = { skipped: 'erro' };
        try { insights = await aiInsightsTick(); } catch (e) { console.error('Erro no digest do Agente de IA:', e); }

        // Sync do gasto de anúncio (Meta Marketing API) — cadência própria: só
        // busca de verdade a cada MARKETING_SYNC_HORAS.
        let marketing = { skipped: 'erro' };
        try { marketing = await marketingSyncTick(); } catch (e) { console.error('Erro no sync de marketing:', e); }

        res.json({ processed, followup, opps, insights, marketing, prev_run: prevRun, prev_run_ago_sec: prevRunAgoSec, followup_ativo: (await followupGetConfig()).ativo });
    } catch (e) { console.error('Erro no tick de fluxos:', e); res.status(500).json({ error: 'Erro interno.' }); }
});

// ==========================================
// FOLLOW-UP AUTOMÁTICO (Fase 1 — cadência global)
// ==========================================
// Quando um lead para de responder (última mensagem da conversa foi nossa),
// envia lembretes numa cadência configurável e para assim que ele responder.
// Dentro da janela de 24h do WhatsApp vai texto livre; fora dela vai o template
// aprovado escolhido no passo (se houver) — senão o passo é pulado.

const FOLLOWUP_DEFAULT = {
    ativo: false,
    steps: [
        { atraso_min: 180,  texto: 'Oi {{nome}}, você chegou a ver minha última mensagem? Consigo te ajudar por aqui 🙂', template_name: '', so_horario_comercial: true },
        { atraso_min: 1440, texto: '{{nome}}, ainda tem interesse? Se quiser, me diz o melhor horário que eu retomo com você.', template_name: '', so_horario_comercial: true },
        { atraso_min: 4320, texto: 'Vou encerrar seu atendimento por aqui por enquanto, mas é só me chamar quando precisar. Um abraço!', template_name: '', so_horario_comercial: true },
    ],
    aplicar_colunas: [],
    parar_em_colunas: ['col-ganho'],
    quiet_start: '20:00',
    quiet_end: '08:00',
    dias_semana: [1, 2, 3, 4, 5, 6],
    acao_final: 'nada',            // 'nada' | 'mover:col-perdido' | 'tag:sem-resposta'
    aplicar_com_humano: true,
    max_por_tick: 25,
};

async function followupGetConfig() {
    try {
        const rows = await queryD1("SELECT value FROM crm_settings WHERE key = 'followup_config'");
        if (rows && rows[0] && rows[0].value) return Object.assign({}, FOLLOWUP_DEFAULT, JSON.parse(rows[0].value));
    } catch (e) {}
    return Object.assign({}, FOLLOWUP_DEFAULT);
}

function followupParseTs(ts) {
    if (!ts) return null;
    const s = String(ts).includes('T') ? String(ts) : String(ts).replace(' ', 'T') + 'Z';
    const d = new Date(s);
    return isNaN(d) ? null : d;
}
function followupInBlockedTime(cfg, date) {
    let sp;
    try { sp = new Date(date.toLocaleString('en-US', { timeZone: cfg.timezone || 'America/Sao_Paulo' })); }
    catch (e) { sp = date; }
    const dow = sp.getDay();
    if (Array.isArray(cfg.dias_semana) && cfg.dias_semana.length && !cfg.dias_semana.includes(dow)) return true;
    const toMin = (str) => { const [h, m] = String(str || '').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
    const qs = toMin(cfg.quiet_start), qe = toMin(cfg.quiet_end);
    if (qs === qe) return false;
    const hm = sp.getHours() * 60 + sp.getMinutes();
    return qs < qe ? (hm >= qs && hm < qe) : (hm >= qs || hm < qe);
}
function followupNextAllowed(cfg, fromDate) {
    let d = new Date(fromDate.getTime());
    for (let i = 0; i < 8 * 48; i++) {
        if (!followupInBlockedTime(cfg, d)) return d;
        d = new Date(d.getTime() + 30 * 60000);
    }
    return d;
}
function followupAtSql(date) { return date.toISOString().slice(0, 19).replace('T', ' '); }

async function followupApplyFinal(cfg, lead) {
    try {
        if (cfg.acao_final === 'mover:col-perdido') {
            await queryD1("UPDATE leads SET column_id = 'col-perdido' WHERE id = ?", [lead.id]);
        } else if (cfg.acao_final === 'tag:sem-resposta') {
            const cur = lead.tags ? String(lead.tags).split(',').map(s => s.trim()).filter(Boolean) : [];
            if (!cur.includes('sem-resposta')) {
                cur.push('sem-resposta');
                await queryD1("UPDATE leads SET tags = ? WHERE id = ?", [cur.join(','), lead.id]);
            }
        }
    } catch (e) { console.error('follow-up: ação final falhou:', e.message); }
}

async function followupTick() {
    const cfg = await followupGetConfig();
    let opened = 0, processed = 0;
    const dbg = { ativo: !!cfg.ativo, janela: 0, ja_terminado: 0, fora_das_colunas: 0, humano_desligado: 0, ja_tem_run: 0, mesma_ancora: 0, flow_esperando: 0 };
    // 'col-ganho' (lead fechado) e 'col-agendado' (já marcou horário) sempre param; o resto é escolha do admin.
    const termCols = (cfg.parar_em_colunas || []).concat(['col-ganho', 'col-agendado']);

    // ---- Estágio A: abrir execuções novas (só cadência global, só se ativa) ----
    // Consultas em LOTE. Antes: ~4 consultas por lead candidato (até 200 leads =
    // ~800 consultas por tick, quase todas só pra descartar o lead que já tinha
    // run). Agora: filtro barato em memória + 3 consultas por bloco de 15 leads
    // (bloco pequeno pro nº de parâmetros ligados não passar do limite do D1).
    if (cfg.ativo && Array.isArray(cfg.steps) && cfg.steps.length) {
        const firstDelay = cfg.steps[0].atraso_min || 60;
        const cutoffDelay = flowDbTime(-firstDelay * 60000);
        const cutoffOld = flowDbTime(-30 * 86400000);
        const cand = await queryD1(
            `SELECT id, nome, telefone, tags, column_id, ai_enabled, last_msg_at
             FROM leads
             WHERE last_msg_direction = 'out' AND last_msg_at IS NOT NULL
               AND last_msg_at <= ? AND last_msg_at >= ?
               AND (campaign_opt_out IS NULL OR campaign_opt_out = 0)
             LIMIT 200`, [cutoffDelay, cutoffOld]);
        dbg.janela = (cand || []).length;

        // Filtros que não precisam de banco — descarta antes de qualquer consulta.
        const elegiveis = (cand || []).filter(lead => {
            if (termCols.includes(lead.column_id)) { dbg.ja_terminado++; return false; }
            if (cfg.aplicar_colunas.length && !cfg.aplicar_colunas.includes(lead.column_id)) { dbg.fora_das_colunas++; return false; }
            if (!cfg.aplicar_com_humano && Number(lead.ai_enabled) === 0) { dbg.humano_desligado++; return false; }
            return true;
        });

        const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

        for (const bloco of chunk(elegiveis, 15)) {
            const ids = bloco.map(l => l.id);
            const phonesByLead = new Map(bloco.map(l => [l.id, phoneVariants(l.telefone || '')]));
            const allPhones = Array.from(new Set([].concat(...phonesByLead.values())));
            const idPh = ids.map(() => '?').join(', ');
            const phPh = allPhones.map(() => '?').join(', ');

            // 1) runs já existentes desses leads (qualquer status)
            const runsRows = ids.length
                ? await queryD1(`SELECT lead_id, status, anchor_out_ts FROM crm_followup_runs WHERE lead_id IN (${idPh})`, ids)
                : [];
            const openLeads = new Set();
            const anchorsByLead = new Map();
            for (const r of runsRows) {
                const lid = String(r.lead_id);
                if (r.status === 'agendado' || r.status === 'enviando') openLeads.add(lid);
                if (!anchorsByLead.has(lid)) anchorsByLead.set(lid, new Set());
                anchorsByLead.get(lid).add(r.anchor_out_ts);
            }

            // 2) fluxos aguardando resposta nesses telefones
            const flowRows = allPhones.length
                ? await queryD1(`SELECT DISTINCT phone FROM crm_flow_runs WHERE status = 'waiting_reply' AND phone IN (${phPh})`, allPhones)
                : [];
            const flowWaitingPhones = new Set(flowRows.map(r => r.phone));

            // 3) última mensagem recebida por telefone
            const lastInRows = allPhones.length
                ? await queryD1(`SELECT phone, MAX(timestamp) AS ts FROM wa_messages WHERE direction = 'in' AND phone IN (${phPh}) GROUP BY phone`, allPhones)
                : [];
            const lastInByPhone = new Map(lastInRows.map(r => [r.phone, r.ts]));

            for (const lead of bloco) {
                try {
                    const lid = String(lead.id);
                    if (openLeads.has(lid)) { dbg.ja_tem_run++; continue; }
                    const anchors = anchorsByLead.get(lid);
                    if (anchors && anchors.has(lead.last_msg_at)) { dbg.mesma_ancora++; continue; }

                    const vph = phonesByLead.get(lead.id) || [];
                    if (vph.some(p => flowWaitingPhones.has(p))) { dbg.flow_esperando++; continue; }

                    let lastInTs = null;
                    for (const p of vph) {
                        const ts = lastInByPhone.get(p);
                        if (ts && (!lastInTs || ts > lastInTs)) lastInTs = ts;
                    }

                    const runId = 'fu-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
                    await queryD1(
                        'INSERT INTO crm_followup_runs (id, lead_id, phone, origem, step_idx, status, anchor_out_ts, last_inbound_ts, next_send_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
                        [runId, lead.id, lead.telefone || '', 'global', 'agendado', lead.last_msg_at, lastInTs, flowDbTime()]);
                    opened++;
                } catch (e) { console.error('follow-up: abertura falhou:', e.message); }
            }
        }
    }

    // ---- Estágio B: processar execuções agendadas ----
    const lim = Math.min(100, Math.max(1, parseInt(cfg.max_por_tick, 10) || 25));
    const runs = await queryD1(
        `SELECT * FROM crm_followup_runs WHERE status = 'agendado' AND next_send_at IS NOT NULL AND next_send_at <= ? ORDER BY next_send_at ASC LIMIT ${lim}`,
        [flowDbTime()]);

    // Orçamento de tempo: se o lote demorar demais (ex.: cada envio à Meta ~0,3-0,5s
    // + updates), para com folga antes de a função serverless estourar o timeout e
    // ser morta no meio. O que sobrar continua 'agendado' com next_send_at vencido
    // e é pego no próximo tick — sem perder nem duplicar nada.
    const STAGE_B_BUDGET_MS = 35000;
    const stageBStart = Date.now();
    let stageBCortado = false;

    for (const run of (runs || [])) {
        if (Date.now() - stageBStart > STAGE_B_BUDGET_MS) { stageBCortado = true; break; }
        try {
            const lr = await queryD1('SELECT * FROM leads WHERE id = ?', [run.lead_id]);
            const lead = lr && lr[0];
            if (!lead) { await queryD1("UPDATE crm_followup_runs SET status = 'parado' WHERE id = ?", [run.id]); continue; }
            const vph = phoneVariants(run.phone || lead.telefone || '');
            const vp = vph.map(() => '?').join(', ');

            // parada: o lead respondeu depois da âncora
            const inAfter = await queryD1(`SELECT timestamp FROM wa_messages WHERE direction = 'in' AND phone IN (${vp}) AND timestamp > ? LIMIT 1`, [...vph, run.anchor_out_ts]);
            if (inAfter && inAfter[0]) { await queryD1("UPDATE crm_followup_runs SET status = 'respondido', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [run.id]); processed++; continue; }
            if (Number(lead.campaign_opt_out) === 1) { await queryD1("UPDATE crm_followup_runs SET status = 'opt_out', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [run.id]); processed++; continue; }
            if (termCols.includes(lead.column_id) || (run.origem === 'global' && !cfg.ativo)) { await queryD1("UPDATE crm_followup_runs SET status = 'parado', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [run.id]); processed++; continue; }

            const steps = Array.isArray(cfg.steps) ? cfg.steps : [];
            if (run.step_idx >= steps.length) {
                await followupApplyFinal(cfg, lead);
                await queryD1("UPDATE crm_followup_runs SET status = 'concluido', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [run.id]);
                processed++; continue;
            }
            const step = steps[run.step_idx];

            if (step.so_horario_comercial && followupInBlockedTime(cfg, new Date())) {
                const nv = followupNextAllowed(cfg, new Date());
                await queryD1("UPDATE crm_followup_runs SET next_send_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [followupAtSql(nv), run.id]);
                continue;
            }

            const lastInRow = await queryD1(`SELECT timestamp FROM wa_messages WHERE direction = 'in' AND phone IN (${vp}) ORDER BY timestamp DESC LIMIT 1`, vph);
            const lastInTs = (lastInRow && lastInRow[0] && lastInRow[0].timestamp) || run.last_inbound_ts;
            const lastInDate = followupParseTs(lastInTs);
            const within24 = lastInDate ? (Date.now() - lastInDate.getTime()) < 24 * 3600000 : false;

            const texto = flowInterpolate(step.texto, { nome: lead.nome || '', telefone: lead.telefone || '' });
            const stepTemplate = String(step.template_name || '').trim();

            // Avança o run ANTES de enviar. Se a função morrer (timeout da Vercel)
            // entre este UPDATE e o envio, o passo é PULADO, nunca reenviado — um
            // follow-up perdido é bem melhor que um follow-up duplicado. O código
            // já ignorava erro de envio e avançava assim mesmo; isto só torna o
            // comportamento consistente também no caso de timeout.
            const nextIdx = run.step_idx + 1;
            const anchor = followupParseTs(run.anchor_out_ts) || new Date();
            const isLast = nextIdx >= steps.length;
            if (isLast) {
                await queryD1("UPDATE crm_followup_runs SET step_idx = ?, attempts = attempts + 1, status = 'concluido', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [nextIdx, run.id]);
            } else {
                const nextAt = new Date(anchor.getTime() + (steps[nextIdx].atraso_min || 60) * 60000);
                await queryD1("UPDATE crm_followup_runs SET step_idx = ?, attempts = attempts + 1, next_send_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [nextIdx, followupAtSql(nextAt), run.id]);
            }

            if (within24 && texto.trim()) {
                try {
                    await sendWhatsappTextInternal(lead.telefone, texto, 'followup');
                    logLeadEvent(lead.id, 'follow_up_automatico', 'sistema', `passo ${run.step_idx + 1}/${steps.length}`);
                }
                catch (e) { console.error('follow-up: envio falhou:', e.message); }
            } else if (stepTemplate) {
                // Fora da janela de 24h (ou passo só com template): texto livre não
                // passa na API oficial — manda o template aprovado. O nome do lead
                // vai como única variável de corpo, se o template tiver uma.
                try {
                    await sendWhatsappTemplateInternal(lead.telefone, stepTemplate, { nome: safeLeadFirstName(lead.nome) || 'Cliente', sentBy: 'followup' });
                    logLeadEvent(lead.id, 'follow_up_automatico', 'sistema', `passo ${run.step_idx + 1}/${steps.length} (template)`);
                }
                catch (e) { console.error('follow-up: template falhou:', e.message); }
            }
            // senão (fora da janela e sem template configurado): passo pulado.

            if (isLast) await followupApplyFinal(cfg, lead);
            processed++;

            // Pequena folga entre envios: não é rate-limit da Meta (o limite é bem
            // maior), é só pra não empilhar o lote inteiro no mesmo instante.
            await new Promise(r => setTimeout(r, 150));
        } catch (e) { console.error('follow-up: run erro:', e.message); }
    }

    if (stageBCortado) console.warn('follow-up: orçamento de tempo do Estágio B esgotado — resto no próximo tick');
    return { opened, processed, debug: dbg, stage_b_cortado: stageBCortado };
}

app.get('/api/followup/config', async (req, res) => {
    try { res.json({ config: await followupGetConfig() }); }
    catch (e) { res.status(500).json({ error: 'Erro interno.' }); }
});

app.put('/api/followup/config', async (req, res) => {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Apenas administradores.' });
    try {
        const b = req.body || {};
        const clean = {
            ativo: !!b.ativo,
            steps: (Array.isArray(b.steps) ? b.steps : []).slice(0, 10).map(s => ({
                atraso_min: Math.max(1, parseInt(s.atraso_min, 10) || 60),
                texto: String(s.texto || '').slice(0, 2000),
                template_name: String(s.template_name || '').trim().slice(0, 120),
                so_horario_comercial: !!s.so_horario_comercial,
            })),
            aplicar_colunas: Array.isArray(b.aplicar_colunas) ? b.aplicar_colunas.map(String) : [],
            parar_em_colunas: Array.isArray(b.parar_em_colunas) ? b.parar_em_colunas.map(String) : ['col-ganho'],
            quiet_start: String(b.quiet_start || '20:00').slice(0, 5),
            quiet_end: String(b.quiet_end || '08:00').slice(0, 5),
            dias_semana: Array.isArray(b.dias_semana) ? b.dias_semana.map(n => parseInt(n, 10)).filter(n => n >= 0 && n <= 6) : [1, 2, 3, 4, 5, 6],
            acao_final: ['nada', 'mover:col-perdido', 'tag:sem-resposta'].includes(b.acao_final) ? b.acao_final : 'nada',
            aplicar_com_humano: b.aplicar_com_humano !== false,
            max_por_tick: Math.min(100, Math.max(1, parseInt(b.max_por_tick, 10) || 25)),
        };
        await queryD1("INSERT INTO crm_settings (key, value) VALUES ('followup_config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(clean)]);
        res.json({ success: true, config: clean });
    } catch (e) { console.error('Erro ao salvar config de follow-up:', e); res.status(500).json({ error: 'Erro interno.' }); }
});

// ============================================================================
// DETECTOR DE OPORTUNIDADES — varre as conversas algumas vezes por dia e
// sinaliza leads "quentes" que estão esperando retorno e demonstraram intenção
// de compra. Funil de 3 camadas (peneira SQL barata -> palavra-chave em
// memória -> 1 chamada Gemini flash) pra o custo de rows_read do D1 ficar
// desprezível. Passivo: NUNCA manda mensagem — só cria uma notificação
// clicável e põe a etiqueta "Oportunidade" no lead.
// ============================================================================
const OPPS_DEFAULT = {
    ativo: true,
    intervalo_horas: 8,           // varredura cara roda no máx 1x a cada X horas
    so_horario_comercial: true,   // usa a mesma janela do follow-up
    colunas: ['col-entrada', 'col-contatado', 'col-orcado', 'col-agendado'],
    gap_min_horas: 2,             // ignora quem mandou msg agora (dá tempo do atendente ver)
    idade_max_dias: 20,           // não olha conversa mais velha que isso
    max_por_rodada: 20,           // teto de leads que vão pra IA por rodada
    palavras_chave: 'preço|preco|valor|quanto|quanto custa|orçamento|orcamento|agendar|agendamento|marcar|marca|horário|horario|ainda tem|quando|disponível|disponivel|tem vaga|vaga|consigo|dá pra|da pra|posso ir|fazer o|fazer a|quero fazer|me chama|retorna',
};
const OPPS_TAG_ID = 'oportunidade';

async function oppsGetConfig() {
    try {
        const rows = await queryD1("SELECT value FROM crm_settings WHERE key = 'opps_config'");
        if (rows && rows[0] && rows[0].value) return Object.assign({}, OPPS_DEFAULT, JSON.parse(rows[0].value));
    } catch (e) {}
    return Object.assign({}, OPPS_DEFAULT);
}

// Etiqueta "Oportunidade" na lista compartilhada (mesmo padrão de
// ensureQualifiedTagExists), sem apagar as etiquetas que já existem.
async function ensureOpportunityTagExists() {
    const rows = await queryD1("SELECT value FROM crm_settings WHERE key = 'whatsapp_custom_tags'");
    let tags = [];
    if (rows && rows[0] && rows[0].value) { try { tags = JSON.parse(rows[0].value); } catch (e) {} }
    if (!Array.isArray(tags) || tags.length === 0) tags = [...WHATSAPP_DEFAULT_TAGS_SEED];
    if (!tags.some(t => t.id === OPPS_TAG_ID)) {
        tags.push({ id: OPPS_TAG_ID, label: '💰 Oportunidade', bg: 'rgba(234, 179, 8, 0.15)', color: '#fbbf24', border: '#eab308' });
        await queryD1("INSERT INTO crm_settings (key, value) VALUES ('whatsapp_custom_tags', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(tags)]);
    }
    return OPPS_TAG_ID;
}
async function tagLeadAsOpportunity(leadId) {
    const tagId = await ensureOpportunityTagExists();
    const rows = await queryD1('SELECT tags FROM leads WHERE id = ?', [leadId]);
    const cur = (rows?.[0]?.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    if (cur.includes(tagId)) return;
    cur.push(tagId);
    await queryD1('UPDATE leads SET tags = ? WHERE id = ?', [cur.join(','), leadId]);
}

// id determinístico: mesma última mensagem do lead => mesma notificação (não
// re-sinaliza). O lead manda algo novo => last_msg_at muda => volta a ser elegível.
function oppNotifId(leadId, lastMsgAt) {
    return 'opp-' + leadId + '-' + String(lastMsgAt || '').replace(/[^0-9]/g, '');
}

// Transcrição curta e redigida (tira telefone/mídia), casando qualquer variante
// do número. ~12-25 linhas lidas via idx_wa_msg_phone_ts.
async function oppsTranscript(phone) {
    const v = phoneVariants(phone || '');
    if (!v.length) return '';
    const ph = v.map(() => '?').join(', ');
    const rows = await queryD1(
        `SELECT direction, message FROM wa_messages WHERE phone IN (${ph}) ORDER BY timestamp DESC LIMIT 12`, v);
    return (rows || []).reverse()
        .map(r => `${r.direction === 'in' ? 'Paciente' : 'Atendimento'}: ${copilotRedact(r.message)}`)
        .join('\n');
}

async function opportunitiesTick(opts = {}) {
    const cfg = await oppsGetConfig();
    if (!cfg.ativo && !opts.force) return { skipped: 'inativo' };

    // ---- Camada 0: cadência (≈1 leitura) ----
    if (!opts.force) {
        if (cfg.so_horario_comercial) {
            const fu = await followupGetConfig();
            if (followupInBlockedTime(fu, new Date())) return { skipped: 'fora_horario' };
        }
        try {
            const lr = await queryD1("SELECT value FROM crm_settings WHERE key = 'opps_last_run'");
            const prev = lr && lr[0] ? followupParseTs(lr[0].value) : null;
            if (prev && (Date.now() - prev.getTime()) < cfg.intervalo_horas * 3600000) {
                return { skipped: 'cadencia', last_run: lr[0].value };
            }
        } catch (e) {}
    }

    const stampLastRun = () => queryD1(
        "INSERT INTO crm_settings (key, value) VALUES ('opps_last_run', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [flowDbTime()]
    ).catch(() => {});

    // ---- Camada 1: peneira SQL barata (1 SELECT, ~60 linhas) ----
    const cutoffRecent = flowDbTime(-(cfg.gap_min_horas || 2) * 3600000);
    const cutoffOld = flowDbTime(-(cfg.idade_max_dias || 20) * 86400000);
    const colunas = (Array.isArray(cfg.colunas) && cfg.colunas.length) ? cfg.colunas.map(String) : OPPS_DEFAULT.colunas;
    const colPh = colunas.map(() => '?').join(', ');
    const cand = await queryD1(
        `SELECT id, nome, telefone, column_id, last_msg_at
         FROM leads
         WHERE last_msg_direction = 'in'
           AND last_msg_at IS NOT NULL
           AND last_msg_at <= ? AND last_msg_at >= ?
           AND column_id IN (${colPh})
           AND (campaign_opt_out IS NULL OR campaign_opt_out = 0)
         ORDER BY last_msg_at DESC
         LIMIT 60`,
        [cutoffRecent, cutoffOld, ...colunas]
    );

    const dbg = { candidatos: (cand || []).length, com_intencao: 0, analisados: 0, sinalizados: 0 };
    if (!cand || !cand.length) { await stampLastRun(); return dbg; }

    // Dedupe: já sinalizados pra a mesma última mensagem
    const candIds = cand.map(c => oppNotifId(c.id, c.last_msg_at));
    let jaVistos = new Set();
    try {
        const seen = await queryD1(
            `SELECT id FROM crm_notifications WHERE id IN (${candIds.map(() => '?').join(', ')})`, candIds);
        jaVistos = new Set((seen || []).map(r => r.id));
    } catch (e) {}

    // ---- Camada 1.5: palavra-chave na última fala do lead (sem IA) ----
    let kwRe;
    try { kwRe = new RegExp('(' + (cfg.palavras_chave || OPPS_DEFAULT.palavras_chave) + ')', 'i'); }
    catch (e) { kwRe = new RegExp('(' + OPPS_DEFAULT.palavras_chave + ')', 'i'); }

    const promissores = [];
    for (const lead of cand) {
        if (promissores.length >= (cfg.max_por_rodada || 20)) break;
        if (jaVistos.has(oppNotifId(lead.id, lead.last_msg_at))) continue;
        let transcript;
        try { transcript = await oppsTranscript(lead.telefone); } catch (e) { continue; }
        if (!transcript) continue;
        const falasLead = transcript.split('\n').filter(l => l.startsWith('Paciente:'));
        const ultimaFala = falasLead.length ? falasLead[falasLead.length - 1] : '';
        if (!kwRe.test(ultimaFala)) continue;
        promissores.push({ lead, transcript });
    }
    dbg.com_intencao = promissores.length;
    if (!promissores.length) { await stampLastRun(); return dbg; }

    // ---- Camada 2: 1 chamada Gemini flash pra o lote inteiro ----
    const contexto = await getWhatsappAiContext();
    const sys = `${contexto}

Você é um analista de vendas. Vou te passar VÁRIAS conversas de WhatsApp entre a clínica e leads. Para CADA conversa, decida se AGORA existe uma oportunidade de venda real que a equipe está deixando passar: o lead demonstrou intenção clara (perguntou preço, quis agendar, pediu horário, disse que quer fazer o procedimento, etc.) e a clínica NÃO deu um encaminhamento adequado — ficou sem resposta, ou respondeu de forma genérica/incompleta.

Responda SOMENTE com um array JSON, sem nenhum texto antes ou depois, no formato:
[{"i": <número da conversa>, "oportunidade": true|false, "motivo": "<no máximo 1 linha, direto>", "proximo_passo": "<no máximo 1 linha, ação concreta pro atendente>"}]

Seja RIGOROSO: se a conversa já foi bem encaminhada, se o lead só agradeceu/despediu, ou se você não tem certeza, marque "oportunidade": false.`;

    const userText = promissores.map((p, idx) =>
        `### CONVERSA ${idx + 1} (lead: ${p.lead.nome || 'sem nome'})\n${p.transcript}`
    ).join('\n\n');

    let veredito = [];
    try {
        const raw = await callGeminiCopilot(sys, userText);
        const m = String(raw || '').match(/\[[\s\S]*\]/);
        if (m) veredito = JSON.parse(m[0]);
    } catch (e) {
        console.error('opps: leitura da IA falhou:', e.message);
        return dbg; // NÃO carimba opps_last_run — tenta de novo no próximo tick
    }
    dbg.analisados = promissores.length;

    for (const v of (Array.isArray(veredito) ? veredito : [])) {
        if (!v || v.oportunidade !== true) continue;
        const p = promissores[Number(v.i) - 1];
        if (!p) continue;
        const nid = oppNotifId(p.lead.id, p.lead.last_msg_at);
        const motivo = String(v.motivo || 'lead quente esperando retorno').replace(/\s+/g, ' ').trim().slice(0, 180);
        const passo = String(v.proximo_passo || '').replace(/\s+/g, ' ').trim().slice(0, 180);
        const nome = (p.lead.nome && !LEAD_NOME_PLACEHOLDER_RE.test(p.lead.nome)) ? p.lead.nome : 'Lead';
        const msg = `💰 ${nome}: ${motivo}${passo ? ' — ' + passo : ''}`;
        try {
            await queryD1(
                "INSERT OR IGNORE INTO crm_notifications (id, message, created_at, action_phone) VALUES (?, ?, CURRENT_TIMESTAMP, ?)",
                [nid, msg, p.lead.telefone || null]
            );
            sendPushToAll('Oportunidade detectada 💰', msg, { phone: p.lead.telefone || null }).catch(() => {});
            await tagLeadAsOpportunity(p.lead.id);
            dbg.sinalizados++;
        } catch (e) { console.error('opps: gravar sinal falhou:', e.message); }
    }

    await stampLastRun();
    return dbg;
}

app.get('/api/opps/config', async (req, res) => {
    try {
        const cfg = await oppsGetConfig();
        let lastRun = null;
        try { const r = await queryD1("SELECT value FROM crm_settings WHERE key = 'opps_last_run'"); lastRun = r && r[0] ? r[0].value : null; } catch (e) {}
        res.json({ config: cfg, last_run: lastRun });
    } catch (e) { res.status(500).json({ error: 'Erro interno.' }); }
});

app.put('/api/opps/config', async (req, res) => {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Apenas administradores.' });
    try {
        const b = req.body || {};
        // Mescla no que já existe — a UI só manda alguns campos, os demais
        // (colunas, thresholds) ficam como estavam.
        const cur = await oppsGetConfig();
        const clean = {
            ativo: b.ativo !== undefined ? !!b.ativo : cur.ativo,
            intervalo_horas: b.intervalo_horas !== undefined ? Math.min(48, Math.max(1, parseInt(b.intervalo_horas, 10) || 8)) : cur.intervalo_horas,
            so_horario_comercial: b.so_horario_comercial !== undefined ? !!b.so_horario_comercial : cur.so_horario_comercial,
            colunas: (Array.isArray(b.colunas) && b.colunas.length) ? b.colunas.map(String) : cur.colunas,
            gap_min_horas: b.gap_min_horas !== undefined ? Math.min(72, Math.max(1, parseInt(b.gap_min_horas, 10) || 2)) : cur.gap_min_horas,
            idade_max_dias: b.idade_max_dias !== undefined ? Math.min(90, Math.max(1, parseInt(b.idade_max_dias, 10) || 20)) : cur.idade_max_dias,
            max_por_rodada: b.max_por_rodada !== undefined ? Math.min(50, Math.max(1, parseInt(b.max_por_rodada, 10) || 20)) : cur.max_por_rodada,
            palavras_chave: b.palavras_chave !== undefined ? String(b.palavras_chave || OPPS_DEFAULT.palavras_chave).slice(0, 1000) : cur.palavras_chave,
        };
        await queryD1("INSERT INTO crm_settings (key, value) VALUES ('opps_config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(clean)]);
        res.json({ success: true, config: clean });
    } catch (e) { console.error('Erro ao salvar config de oportunidades:', e); res.status(500).json({ error: 'Erro interno.' }); }
});

app.post('/api/opps/run', async (req, res) => {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Apenas administradores.' });
    try {
        try {
            const r = await queryD1("SELECT value FROM crm_settings WHERE key = 'opps_manual_last'");
            const prev = r && r[0] ? followupParseTs(r[0].value) : null;
            if (prev && (Date.now() - prev.getTime()) < 3600000) {
                return res.status(429).json({ error: 'Já rodou há menos de 1h. Aguarde.' });
            }
        } catch (e) {}
        await queryD1("INSERT INTO crm_settings (key, value) VALUES ('opps_manual_last', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [flowDbTime()]);
        const result = await opportunitiesTick({ force: true });
        res.json({ success: true, result });
    } catch (e) { console.error('opps/run:', e); res.status(500).json({ error: 'Erro interno.' }); }
});

// ============================================================================
// AGENTE DE IA (painel "Ask AI" da topbar) — responde perguntas de gestão
// sobre a carteira de leads ("como estão", "principal queixa", "por que não
// fecham", "feedback geral"). Economia de tokens em 3 camadas:
//   1) Números do funil vêm PRONTOS do front (já em memória, zero leitura no D1);
//   2) Queixas/motivos de perda são um "digest" gerado no máximo 1x a cada
//      intervalo_horas (mesmo molde do detector de oportunidades) e CACHEADO
//      em crm_settings — nunca reprocessado a cada pergunta;
//   3) A pergunta em si usa só esses dois resumos como contexto (nunca o
//      histórico bruto de todas as conversas) — 1 chamada Gemini curta por
//      pergunta, sempre no mesmo modelo barato já usado no resto do sistema.
// ============================================================================
const AI_INSIGHTS_DEFAULT = {
    ativo: true,
    intervalo_horas: 6,
    colunas_amostra: ['col-perdido', 'col-orcado'],
    max_conversas: 25,
    idade_max_dias: 45,
};

async function aiInsightsGetConfig() {
    try {
        const rows = await queryD1("SELECT value FROM crm_settings WHERE key = 'ai_insights_config'");
        if (rows && rows[0] && rows[0].value) return Object.assign({}, AI_INSIGHTS_DEFAULT, JSON.parse(rows[0].value));
    } catch (e) {}
    return Object.assign({}, AI_INSIGHTS_DEFAULT);
}

async function aiInsightsTick(opts = {}) {
    const cfg = await aiInsightsGetConfig();
    if (!cfg.ativo && !opts.force) return { skipped: 'inativo' };

    if (!opts.force) {
        try {
            const lr = await queryD1("SELECT value FROM crm_settings WHERE key = 'ai_insights_last_run'");
            const prev = lr && lr[0] ? followupParseTs(lr[0].value) : null;
            if (prev && (Date.now() - prev.getTime()) < cfg.intervalo_horas * 3600000) {
                return { skipped: 'cadencia', last_run: lr[0].value };
            }
        } catch (e) {}
    }

    const stampLastRun = () => queryD1(
        "INSERT INTO crm_settings (key, value) VALUES ('ai_insights_last_run', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [flowDbTime()]
    ).catch(() => {});

    // ---- Amostra: leads parados/perdidos mais recentes (1 SELECT) ----
    const cutoffOld = flowDbTime(-(cfg.idade_max_dias || 45) * 86400000);
    const colunas = (Array.isArray(cfg.colunas_amostra) && cfg.colunas_amostra.length) ? cfg.colunas_amostra.map(String) : AI_INSIGHTS_DEFAULT.colunas_amostra;
    const colPh = colunas.map(() => '?').join(', ');
    const cand = await queryD1(
        `SELECT id, nome, telefone
         FROM leads
         WHERE column_id IN (${colPh})
           AND COALESCE(last_msg_at, created_at) >= ?
         ORDER BY COALESCE(last_msg_at, created_at) DESC
         LIMIT ?`,
        [...colunas, cutoffOld, cfg.max_conversas || 25]
    );

    const dbg = { candidatos: (cand || []).length, analisados: 0 };
    if (!cand || !cand.length) { await stampLastRun(); return dbg; }

    const transcritos = [];
    for (const lead of cand) {
        let transcript;
        try { transcript = await oppsTranscript(lead.telefone); } catch (e) { continue; }
        if (!transcript) continue;
        transcritos.push({ lead, transcript });
    }
    dbg.analisados = transcritos.length;
    if (!transcritos.length) { await stampLastRun(); return dbg; }

    // ---- 1 chamada Gemini pra o lote inteiro (nunca 1 chamada por conversa) ----
    const contexto = await getWhatsappAiContext();
    const sys = `${contexto}

Você é um analista de atendimento de uma clínica. Vou te passar várias conversas de WhatsApp com leads que NÃO fecharam (estão parados ou perdidos no funil). Analise o CONJUNTO e responda SOMENTE com um JSON, sem texto antes ou depois, no formato:
{"principais_queixas": ["...", "..."], "motivos_nao_fechamento": ["...", "..."], "resumo_geral": "..."}

Regras: cada item das listas em no máximo 1 linha direta; no máximo 5 itens por lista; "resumo_geral" em até 3 linhas. Baseie-se só no que está escrito nas conversas — se não der pra identificar um padrão claro em algum campo, deixe a lista vazia. Português do Brasil.`;

    const userText = transcritos.map((t, idx) =>
        `### CONVERSA ${idx + 1} (lead: ${t.lead.nome || 'sem nome'})\n${t.transcript}`
    ).join('\n\n');

    let digest = null;
    try {
        const raw = await callGeminiCopilot(sys, userText);
        const m = String(raw || '').match(/\{[\s\S]*\}/);
        if (m) digest = JSON.parse(m[0]);
    } catch (e) {
        console.error('ai-insights: geração do digest falhou:', e.message);
        return dbg; // não carimba last_run — tenta de novo no próximo tick
    }
    if (!digest) { return dbg; }

    await queryD1(
        "INSERT INTO crm_settings (key, value) VALUES ('ai_insights_digest', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [JSON.stringify(digest)]
    );
    await stampLastRun();
    dbg.digest = digest;
    return dbg;
}

app.get('/api/ai-agent/digest', async (req, res) => {
    try {
        const cfg = await aiInsightsGetConfig();
        const rows = await queryD1("SELECT value FROM crm_settings WHERE key = 'ai_insights_digest'");
        const lastRun = await queryD1("SELECT value FROM crm_settings WHERE key = 'ai_insights_last_run'");
        let digest = null;
        if (rows && rows[0] && rows[0].value) { try { digest = JSON.parse(rows[0].value); } catch (e) {} }
        res.json({ digest, last_run: (lastRun && lastRun[0]) ? lastRun[0].value : null, ativo: cfg.ativo });
    } catch (e) { console.error('ai-agent/digest:', e); res.status(500).json({ error: 'Erro interno.' }); }
});

app.post('/api/ai-agent/refresh', async (req, res) => {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Apenas administradores.' });
    try {
        const r = await queryD1("SELECT value FROM crm_settings WHERE key = 'ai_insights_manual_last'");
        const prev = r && r[0] ? followupParseTs(r[0].value) : null;
        if (prev && (Date.now() - prev.getTime()) < 3600000) {
            return res.status(429).json({ error: 'A análise já foi atualizada há menos de 1h. Aguarde.' });
        }
        await queryD1("INSERT INTO crm_settings (key, value) VALUES ('ai_insights_manual_last', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [flowDbTime()]);
        const result = await aiInsightsTick({ force: true });
        res.json({ success: true, result });
    } catch (e) { console.error('ai-agent/refresh:', e); res.status(500).json({ error: 'Erro interno.' }); }
});

// Perguntas livres do atendente/gestor no painel. "funil" vem PRONTO do front
// (contagem por coluna já calculada em memória — zero leitura extra no D1).
app.post('/api/ai-agent/ask', async (req, res) => {
    try {
        if (!copilotThrottle(req, res)) return;
        const pergunta = String(req.body?.pergunta || '').trim().slice(0, 500);
        if (!pergunta) return res.status(400).json({ error: 'Digite uma pergunta.' });

        const historico = Array.isArray(req.body?.historico) ? req.body.historico.slice(-6) : [];
        const funil = req.body?.funil && typeof req.body.funil === 'object' ? req.body.funil : {};

        const digestRows = await queryD1("SELECT value FROM crm_settings WHERE key = 'ai_insights_digest'");
        const lastRunRows = await queryD1("SELECT value FROM crm_settings WHERE key = 'ai_insights_last_run'");
        let digest = null;
        if (digestRows && digestRows[0] && digestRows[0].value) { try { digest = JSON.parse(digestRows[0].value); } catch (e) {} }

        // Números só como texto simples — nunca deixamos o modelo "inventar" um
        // valor que não veio daqui.
        const funilTexto = Object.keys(funil).length
            ? Object.entries(funil).map(([k, v]) => `${k}: ${v}`).join(', ')
            : 'não disponível nesta sessão';

        const digestTexto = digest
            ? `Principais queixas: ${(digest.principais_queixas || []).join(' | ') || 'nenhuma identificada'}\nMotivos de não-fechamento: ${(digest.motivos_nao_fechamento || []).join(' | ') || 'nenhum identificado'}\nResumo geral: ${digest.resumo_geral || '-'}`
            : 'Ainda não há análise qualitativa gerada (roda automaticamente a cada poucas horas).';

        const contexto = await getWhatsappAiContext();
        const sys = `${contexto}

Você é o assistente interno de gestão do CRM de uma clínica — fala com o ATENDENTE/GESTOR, nunca com o paciente. Responda a pergunta dele usando SOMENTE os dados abaixo (não invente números nem fatos que não estão aqui). Seja direto, use bullets quando ajudar a leitura, português do Brasil, sem saudação nem despedida.

DADOS DISPONÍVEIS:
- Funil de leads (contagem por coluna): ${funilTexto}
- Última análise qualitativa das conversas (${(lastRunRows && lastRunRows[0]) ? lastRunRows[0].value : 'ainda não rodou'}):
${digestTexto}

Se a pergunta pedir algo que não está nos dados acima, diga isso claramente em vez de inventar.`;

        const userText = historico.map(h => `${h.role === 'user' ? 'Atendente' : 'Você'}: ${h.text}`).join('\n')
            + (historico.length ? '\n' : '') + `Atendente: ${pergunta}`;

        const resposta = await callGeminiCopilot(sys, userText);
        res.json({ resposta: resposta || 'Não consegui gerar uma resposta agora.' });
    } catch (e) {
        console.error('ai-agent/ask:', e.message);
        res.status(502).json({ error: e.message || 'Falha ao consultar o agente de IA.' });
    }
});

// Linha do tempo estruturada do lead (quem iniciou/finalizou atendimento,
// abriu orçamento, mudou de etapa, recontatou, etc.) — separado das notas
// manuais, que continuam em leads.notas.
app.get('/api/leads/:id/events', async (req, res) => {
    try {
        const rows = await queryD1(
            'SELECT id, tipo, actor, detalhe, created_at FROM crm_lead_events WHERE lead_id = ? ORDER BY created_at DESC LIMIT 100',
            [req.params.id]
        );
        res.json({ events: rows || [] });
    } catch (e) {
        console.error('leads/:id/events:', e.message);
        res.status(500).json({ error: 'Erro interno.' });
    }
});

// Comentário manual do atendente na linha do tempo do lead (tipo='comentario').
app.post('/api/leads/:id/events', async (req, res) => {
    try {
        const texto = String((req.body && req.body.texto) || '').trim();
        if (!texto) return res.status(400).json({ error: 'Comentário vazio.' });
        if (texto.length > 2000) return res.status(400).json({ error: 'Comentário muito longo (máx. 2000 caracteres).' });
        const id = 'ev-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const actor = req.user?.username || null;
        await queryD1(
            'INSERT INTO crm_lead_events (id, lead_id, tipo, actor, detalhe) VALUES (?, ?, ?, ?, ?)',
            [id, req.params.id, 'comentario', actor, texto]
        );
        res.status(201).json({
            event: { id, tipo: 'comentario', actor, detalhe: texto, created_at: new Date().toISOString().slice(0, 19).replace('T', ' ') }
        });
    } catch (e) {
        console.error('POST leads/:id/events:', e.message);
        res.status(500).json({ error: 'Erro ao salvar comentário.' });
    }
});

// Remove um comentário. Só comentários (nunca eventos do sistema) e só o autor
// ou um admin.
app.delete('/api/leads/:id/events/:eventId', async (req, res) => {
    try {
        const rows = await queryD1(
            'SELECT actor, tipo FROM crm_lead_events WHERE id = ? AND lead_id = ?',
            [req.params.eventId, req.params.id]
        );
        const ev = rows && rows[0];
        if (!ev) return res.status(404).json({ error: 'Comentário não encontrado.' });
        if (ev.tipo !== 'comentario') return res.status(400).json({ error: 'Só comentários podem ser removidos.' });
        const isAdmin = req.user?.role === 'admin';
        if (!isAdmin && ev.actor !== req.user?.username) {
            return res.status(403).json({ error: 'Só o autor ou um admin pode remover.' });
        }
        await queryD1('DELETE FROM crm_lead_events WHERE id = ?', [req.params.eventId]);
        res.json({ success: true });
    } catch (e) {
        console.error('DELETE leads/:id/events:', e.message);
        res.status(500).json({ error: 'Erro ao remover comentário.' });
    }
});

app.get('/api/leads/:id/followup', async (req, res) => {
    try {
        const rows = await queryD1("SELECT * FROM crm_followup_runs WHERE lead_id = ? ORDER BY updated_at DESC LIMIT 1", [req.params.id]);
        res.json({ run: (rows && rows[0]) || null });
    } catch (e) { res.status(500).json({ error: 'Erro interno.' }); }
});

app.post('/api/leads/:id/followup/stop', async (req, res) => {
    try {
        await queryD1("UPDATE crm_followup_runs SET status = 'parado', updated_at = CURRENT_TIMESTAMP WHERE lead_id = ? AND status IN ('agendado','enviando')", [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Erro interno.' }); }
});

app.post('/api/leads/:id/followup/start', async (req, res) => {
    try {
        const lr = await queryD1('SELECT * FROM leads WHERE id = ?', [req.params.id]);
        const lead = lr && lr[0];
        if (!lead) return res.status(404).json({ error: 'Lead não encontrado.' });
        const open = await queryD1("SELECT id FROM crm_followup_runs WHERE lead_id = ? AND status IN ('agendado','enviando') LIMIT 1", [lead.id]);
        if (open && open[0]) return res.json({ success: true, already: true });
        const vph = phoneVariants(lead.telefone || '');
        const vp = vph.map(() => '?').join(', ');
        const lastOut = await queryD1(`SELECT timestamp FROM wa_messages WHERE direction = 'out' AND phone IN (${vp}) ORDER BY timestamp DESC LIMIT 1`, vph);
        const lastIn = await queryD1(`SELECT timestamp FROM wa_messages WHERE direction = 'in' AND phone IN (${vp}) ORDER BY timestamp DESC LIMIT 1`, vph);
        const anchor = (lastOut && lastOut[0] && lastOut[0].timestamp) || flowDbTime();
        const runId = 'fu-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        await queryD1(
            'INSERT INTO crm_followup_runs (id, lead_id, phone, origem, step_idx, status, anchor_out_ts, last_inbound_ts, next_send_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
            [runId, lead.id, lead.telefone || '', 'manual:' + ((req.user && req.user.username) || '?'), 'agendado', anchor, (lastIn && lastIn[0] && lastIn[0].timestamp) || null, flowDbTime()]);
        res.json({ success: true, id: runId });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno.' }); }
});

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
