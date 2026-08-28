// === WHATSAPP CHAT LOGIC ===
let quickReplies = [];
let editingQuickReplyShortcut = null;
let activeQuickReplyIndex = 0;

// ============================================
// TRAVA DE ATENDIMENTO (evita atropelo entre atendentes na mesma conversa)
// ============================================
const LEAD_LOCK_RENEW_INTERVAL_MS = 60 * 1000; // renova a posse a cada 60s enquanto a conversa está aberta
const LEAD_LOCK_TIMEOUT_MS = 5 * 60 * 1000; // precisa bater com LOCK_TIMEOUT_MINUTES no api-server.js

window.chatLockState = { leadId: null, locked: false, ownerId: null };
let leadLockRenewTimer = null;

function parseD1TimestampMs(rawTs) {
    if (!rawTs) return 0;
    let isoStr = String(rawTs).trim();
    if (isoStr.includes(' ') && !isoStr.includes('T')) {
        isoStr = isoStr.replace(' ', 'T') + 'Z';
    }
    const ms = new Date(isoStr).getTime();
    return isNaN(ms) ? 0 : ms;
}

function stopLeadLockRenewal() {
    if (leadLockRenewTimer) {
        clearInterval(leadLockRenewTimer);
        leadLockRenewTimer = null;
    }
}

function applyChatLockUI(locked, ownerName) {
    const banner = document.getElementById('chat-lock-banner');
    const bannerText = document.getElementById('chat-lock-banner-text');
    const input = document.getElementById('chat-input-text');
    const sendBtn = document.getElementById('btn-chat-send');
    const attachBtn = document.getElementById('btn-chat-attach');

    if (banner) banner.style.display = locked ? 'flex' : 'none';
    if (bannerText && locked) {
        bannerText.textContent = `Esta conversa está em atendimento por ${ownerName || 'outro atendente'}. Ela ficará disponível assim que ele(a) ficar inativo(a).`;
    }
    if (input) input.disabled = !!locked;
    if (sendBtn) sendBtn.disabled = !!locked;
    if (attachBtn) attachBtn.disabled = !!locked;
}

function getLockOwnerDisplayName(ownerId) {
    if (!ownerId) return 'outro atendente';
    return (typeof resolveDisplayName === 'function') ? resolveDisplayName(ownerId) : ownerId;
}

// Tenta assumir o atendimento de um lead. Retorna true se a conversa ficou livre para uso.
async function claimLeadConversation(leadId) {
    if (!leadId) return true;
    try {
        const res = await fetch(`/api/leads/${leadId}/claim`, { method: 'POST' });
        const json = await res.json().catch(() => ({}));

        if (res.ok && json.success) {
            window.chatLockState = { leadId, locked: false, ownerId: json.owner_id };
            applyChatLockUI(false);
            stopLeadLockRenewal();
            leadLockRenewTimer = setInterval(() => renewLeadConversation(leadId), LEAD_LOCK_RENEW_INTERVAL_MS);
            return true;
        }

        window.chatLockState = { leadId, locked: true, ownerId: json.owner_id || null };
        applyChatLockUI(true, getLockOwnerDisplayName(json.owner_id));
        stopLeadLockRenewal();
        return false;
    } catch (e) {
        console.error('Erro ao assumir a conversa:', e);
        return true; // falha de rede não deve travar o atendimento
    }
}

// Heartbeat: renova a posse enquanto o atendente segue ativo na conversa aberta.
async function renewLeadConversation(leadId) {
    try {
        const res = await fetch(`/api/leads/${leadId}/renew`, { method: 'POST' });
        const json = await res.json().catch(() => ({}));

        if (!res.ok || !json.success) {
            stopLeadLockRenewal();
            window.chatLockState = { leadId, locked: true, ownerId: json.owner_id || null };
            applyChatLockUI(true, getLockOwnerDisplayName(json.owner_id));
        }
    } catch (e) {
        console.error('Erro ao renovar a posse da conversa:', e);
    }
}

// Libera a conversa explicitamente (ex.: ao fechar a aba). Best-effort, não bloqueia a navegação.
function releaseLeadConversation(leadId) {
    if (!leadId) return;
    try {
        if (navigator.sendBeacon) {
            navigator.sendBeacon(`/api/leads/${leadId}/release`, new Blob([], { type: 'text/plain' }));
        } else {
            fetch(`/api/leads/${leadId}/release`, { method: 'POST', keepalive: true }).catch(() => {});
        }
    } catch (e) {}
}

window.addEventListener('beforeunload', () => {
    if (window.chatLockState && window.chatLockState.leadId && !window.chatLockState.locked) {
        releaseLeadConversation(window.chatLockState.leadId);
    }
});

function formatChatTime(rawTs) {
    if (!rawTs) return '';
    let d;
    if (typeof rawTs === 'number') {
        d = rawTs < 10000000000 ? new Date(rawTs * 1000) : new Date(rawTs);
    } else if (typeof rawTs === 'string') {
        const cleanStr = rawTs.trim();
        if (/^\d+$/.test(cleanStr)) {
            const num = Number(cleanStr);
            d = num < 10000000000 ? new Date(num * 1000) : new Date(num);
        } else {
            let isoStr = cleanStr;
            if (isoStr.includes(' ') && !isoStr.includes('T')) {
                isoStr = isoStr.replace(' ', 'T') + 'Z';
            }
            d = new Date(isoStr);
        }
    } else {
        d = new Date(rawTs);
    }

    if (!d || isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatFullChatDate(rawTs) {
    if (!rawTs) return '';
    let d;
    if (typeof rawTs === 'number') {
        d = rawTs < 10000000000 ? new Date(rawTs * 1000) : new Date(rawTs);
    } else if (typeof rawTs === 'string') {
        const cleanStr = rawTs.trim();
        if (/^\d+$/.test(cleanStr)) {
            const num = Number(cleanStr);
            d = num < 10000000000 ? new Date(num * 1000) : new Date(num);
        } else {
            let isoStr = cleanStr;
            if (isoStr.includes(' ') && !isoStr.includes('T')) {
                isoStr = isoStr.replace(' ', 'T') + 'Z';
            }
            d = new Date(isoStr);
        }
    } else {
        d = new Date(rawTs);
    }

    if (!d || isNaN(d.getTime())) return '';

    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday = d.toDateString() === yesterday.toDateString();

    if (isToday) return 'Hoje';
    if (isYesterday) return 'Ontem';

    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
}

function normalizePhoneBR(phoneStr) {
    if (!phoneStr) return '';
    let digits = String(phoneStr).replace(/\D/g, '');
    // Adiciona 55 se não tiver
    if (digits.length >= 10 && !digits.startsWith('55')) {
        digits = '55' + digits;
    }
    return digits;
}

// Forma canônica: 55 + DDD(2) + 8 dígitos (remove o 9 transicional brasileiro)
function canonicalPhoneBR(phoneStr) {
    if (!phoneStr) return '';
    let digits = String(phoneStr).replace(/\D/g, '');
    if (digits.length >= 10 && !digits.startsWith('55')) {
        digits = '55' + digits;
    }
    // Se tiver 13 dígitos: 55 + DDD(2) + 9 dígitos (com 9 transicional)
    if (digits.length === 13 && digits.startsWith('55')) {
        const local = digits.slice(4); // 9 dígitos
        if (local.startsWith('9')) {
            return digits.slice(0, 4) + local.slice(1); // remove o 9
        }
    }
    return digits;
}

function getPhoneLast10(phoneStr) {
    if (!phoneStr) return '';
    const digits = String(phoneStr).replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : digits;
}

function isSamePhone(p1, p2) {
    if (!p1 || !p2) return false;
    return canonicalPhoneBR(p1) === canonicalPhoneBR(p2);
}

function renderAvatarHTML(name, imgUrl = null, status = 'online', size = 40) {
    const cleanName = (name || 'Contato').replace(/^Contato\s*/i, '').trim() || name || '?';
    const parts = cleanName.split(/\s+/).filter(Boolean);
    let initials = '';
    
    // Remove emojis specifically for the initials, leaving only text
    const textOnlyName = cleanName.replace(/[\u1000-\uFFFF]/g, '').trim();
    const textParts = textOnlyName.split(/\s+/).filter(Boolean);
    
    if (textParts.length >= 2) {
        initials = (Array.from(textParts[0])[0] + Array.from(textParts[1])[0]).toUpperCase();
    } else if (textParts.length === 1 && textParts[0].length >= 1) {
        const chars = Array.from(textParts[0]);
        initials = (chars[0] + (chars[1] || '')).toUpperCase();
    } else if (parts.length >= 1) {
        // Fallback se o nome for só emojis
        const chars = Array.from(parts[0]);
        initials = chars[0] || '?';
    } else {
        initials = '?';
    }

    const contentHTML = imgUrl
        ? `<div class="avatar-image" data-slot="avatar-image"><img src="${imgUrl}" alt="${escapeHtml(cleanName)}" /></div>`
        : `<div class="avatar-fallback" data-slot="avatar-fallback">${initials}</div>`;

    const statusHTML = status
        ? `<div class="avatar-status ${status}" data-slot="avatar-status"></div>`
        : '';

    return `
        <div class="avatar" data-slot="avatar" style="width: ${size}px; height: ${size}px;">
            ${contentHTML}
            ${statusHTML}
        </div>
    `;
}

function getLeadOnlineStatus(lastMsgTimestamp, lastDirection) {
    if (!lastMsgTimestamp) return { isOnline: false, text: '• Visto recentemente', statusClass: 'offline' };

    const msgDate = new Date(lastMsgTimestamp);
    if (isNaN(msgDate.getTime())) {
        return { isOnline: false, text: '• Visto recentemente', statusClass: 'offline' };
    }

    const now = new Date();
    const diffMinutes = Math.floor((now - msgDate) / (1000 * 60));

    if (diffMinutes <= 20) {
        return { isOnline: true, text: '• 🟢 Online agora', statusClass: 'online' };
    }

    if (diffMinutes < 60) {
        return { isOnline: false, text: `• Visto há ${diffMinutes} min`, statusClass: 'offline' };
    }

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) {
        const timeStr = msgDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        return { isOnline: false, text: `• Visto hoje às ${timeStr}`, statusClass: 'offline' };
    }

    const dateStr = msgDate.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    const timeStr = msgDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return { isOnline: false, text: `• Visto em ${dateStr} às ${timeStr}`, statusClass: 'offline' };
}

// === WAVEFORM AUDIO VISUALIZER LOGIC ===
const WAVEFORM_PRESET_HEIGHTS = [
    35, 60, 40, 80, 100, 70, 45, 90, 65, 30, 
    85, 50, 95, 40, 75, 60, 100, 80, 45, 90, 
    65, 35, 70, 50, 85, 40, 60, 30
];

function generateWaveformBarsHTML(playerId) {
    return WAVEFORM_PRESET_HEIGHTS.map((height, idx) => {
        return `<div class="waveform-bar" id="${playerId}-bar-${idx}" style="height: ${height}%;"></div>`;
    }).join('');
}

function formatAudioTime(seconds) {
    if (!seconds || isNaN(seconds) || seconds === Infinity) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

function initWaveformPlayer(playerId) {
    const playerEl = document.getElementById(playerId);
    if (!playerEl || playerEl.dataset.initialized === 'true') return;
    playerEl.dataset.initialized = 'true';

    const audio = document.getElementById(`${playerId}-audio`);
    const barsContainer = playerEl.querySelector('.waveform-bars-container');
    const timeEl = playerEl.querySelector('.waveform-time');

    if (barsContainer && !barsContainer.children.length) {
        barsContainer.innerHTML = generateWaveformBarsHTML(playerId);
    }

    if (audio) {
        audio.addEventListener('loadedmetadata', () => {
            if (timeEl) timeEl.textContent = formatAudioTime(audio.duration);
        });

        audio.addEventListener('timeupdate', () => {
            if (!audio.duration) return;
            const progress = audio.currentTime / audio.duration;
            const totalBars = WAVEFORM_PRESET_HEIGHTS.length;
            const activeIndex = Math.floor(progress * totalBars);

            for (let i = 0; i < totalBars; i++) {
                const bar = document.getElementById(`${playerId}-bar-${i}`);
                if (bar) {
                    if (i <= activeIndex) {
                        bar.classList.add('active');
                    } else {
                        bar.classList.remove('active');
                    }
                }
            }

            if (timeEl) {
                timeEl.textContent = `${formatAudioTime(audio.currentTime)} / ${formatAudioTime(audio.duration)}`;
            }
        });

        audio.addEventListener('ended', () => {
            const btn = playerEl.querySelector('.waveform-play-btn');
            if (btn) {
                btn.classList.remove('playing');
                btn.innerHTML = '<i class="fa-solid fa-play"></i>';
            }
            const totalBars = WAVEFORM_PRESET_HEIGHTS.length;
            for (let i = 0; i < totalBars; i++) {
                const bar = document.getElementById(`${playerId}-bar-${i}`);
                if (bar) bar.classList.remove('active');
            }
            if (timeEl && audio.duration) {
                timeEl.textContent = formatAudioTime(audio.duration);
            }
        });
    }
}

function toggleWaveformPlay(playerId) {
    initWaveformPlayer(playerId);
    const audio = document.getElementById(`${playerId}-audio`);
    const playerEl = document.getElementById(playerId);
    if (!audio || !playerEl) return;

    // Pausar outros áudios que estiverem tocando
    document.querySelectorAll('audio').forEach(a => {
        if (a !== audio && !a.paused) {
            a.pause();
            const otherPlayerId = a.id.replace('-audio', '');
            const otherBtn = document.querySelector(`#${otherPlayerId} .waveform-play-btn`);
            if (otherBtn) {
                otherBtn.classList.remove('playing');
                otherBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
            }
        }
    });

    const btn = playerEl.querySelector('.waveform-play-btn');
    if (audio.paused) {
        audio.play().then(() => {
            if (btn) {
                btn.classList.add('playing');
                btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
            }
        }).catch(console.error);
    } else {
        audio.pause();
        if (btn) {
            btn.classList.remove('playing');
            btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        }
    }
}

function seekWaveform(event, playerId) {
    initWaveformPlayer(playerId);
    const audio = document.getElementById(`${playerId}-audio`);
    const playerEl = document.getElementById(playerId);
    if (!audio || !playerEl || !audio.duration) return;

    const barsContainer = playerEl.querySelector('.waveform-bars-container');
    if (!barsContainer) return;

    const rect = barsContainer.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, clickX / rect.width));

    audio.currentTime = ratio * audio.duration;

    if (audio.paused) {
        toggleWaveformPlay(playerId);
    }
}

function cycleWaveformSpeed(playerId) {
    initWaveformPlayer(playerId);
    const audio = document.getElementById(`${playerId}-audio`);
    const playerEl = document.getElementById(playerId);
    if (!audio || !playerEl) return;

    const speedBtn = playerEl.querySelector('.waveform-speed-btn');
    const speeds = [1, 1.5, 2];
    const currentSpeed = audio.playbackRate || 1;
    const nextIdx = (speeds.indexOf(currentSpeed) + 1) % speeds.length;
    const newSpeed = speeds[nextIdx];

    audio.playbackRate = newSpeed;
    if (speedBtn) speedBtn.textContent = `${newSpeed}x`;
}

function setReplyTo(msgId) {
    if (!window.activeChatMessages) return;
    const msg = window.activeChatMessages.find(m => m.id === msgId);
    if (!msg) return;
    
    window.pendingReplyTo = msg;
    
    // Mostra o preview de resposta
    let cleanText = msg.message;
    let fileName = '';
    if (msg.message.includes('[FILE:')) {
        const match = msg.message.match(/\[FILE:(.*?)\]/);
        if (match && match[1]) {
            fileName = match[1];
            cleanText = msg.message.replace(/\[FILE:.*?\]\n?/, '').replace(/\[CAPTION:.*?\]\n?/, '');
        }
    }
    
    const isImage = cleanText.includes('data:image/') || cleanText.includes('.jpg') || cleanText.includes('.jpeg') || cleanText.includes('.png') || cleanText.includes('.gif') || cleanText.includes('.webp');
    const isAudio = cleanText.includes('data:audio/') || cleanText.includes('.mp3') || cleanText.includes('.ogg') || cleanText.includes('.wav') || cleanText.includes('.m4a');
    const isVideo = cleanText.includes('data:video/') || cleanText.includes('.mp4') || cleanText.includes('.mov') || cleanText.includes('.avi') || cleanText.includes('.webm');
    const isDoc = cleanText.includes('data:application/') || cleanText.includes('.pdf') || cleanText.includes('.doc') || cleanText.includes('.docx') || cleanText.includes('.xlsx');

    let previewText = '';
    if (isImage) previewText = '📷 Foto';
    else if (isAudio) previewText = '🎵 Áudio';
    else if (isVideo) previewText = '🎥 Vídeo';
    else if (isDoc) previewText = `📄 ${fileName || 'Documento'}`;
    else previewText = cleanText;

    const sender = msg.direction === 'out' ? 'Você' : (window.currentActiveChat ? window.currentActiveChat.name : 'Cliente');

    const previewEl = document.getElementById('chat-reply-preview');
    const previewTextEl = document.getElementById('chat-reply-preview-text');
    
    if (previewEl && previewTextEl) {
        previewTextEl.textContent = `${sender}: ${previewText}`;
        previewEl.style.display = 'flex';
    }
    
    const input = document.getElementById('chat-input-text');
    if (input) {
        input.focus();
    }
}

function cancelReplyTo() {
    window.pendingReplyTo = null;
    const previewEl = document.getElementById('chat-reply-preview');
    if (previewEl) {
        previewEl.style.display = 'none';
    }
}

let activeMenuMsgId = null;
let pendingForwardMessage = null;

function toggleMsgDropdown(event, msgId) {
    event.preventDefault();
    event.stopPropagation();
    
    const menu = document.getElementById('msg-global-dropdown');
    if (!menu) return;
    
    if (menu.style.display === 'block' && activeMenuMsgId === msgId) {
        menu.style.display = 'none';
        activeMenuMsgId = null;
        return;
    }
    
    activeMenuMsgId = msgId;
    
    const msg = window.activeChatMessages.find(m => m.id === msgId);
    
    const baixarItem = document.getElementById('menu-item-baixar');
    if (baixarItem) {
        const isFile = msg && msg.message && msg.message.includes('[FILE:');
        baixarItem.style.display = isFile ? 'flex' : 'none';
    }

    const rect = event.currentTarget.getBoundingClientRect();
    
    let top = rect.bottom + window.scrollY;
    let left = rect.left + window.scrollX - 180;
    
    if (left < 10) left = 10;
    
    // Abre para cima se não couber embaixo
    if (rect.bottom + 280 > window.innerHeight) {
        top = rect.top + window.scrollY - 280;
    }
    
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
    menu.style.position = 'absolute';
    menu.style.display = 'block';
}

// Fechar menu ao clicar fora
document.addEventListener('click', function(e) {
    const menu = document.getElementById('msg-global-dropdown');
    if (menu && menu.style.display === 'block') {
        if (!menu.contains(e.target) && !e.target.closest('.msg-dropdown-trigger')) {
            menu.style.display = 'none';
            activeMenuMsgId = null;
        }
    }
});

function triggerMsgAction(action) {
    const msgId = activeMenuMsgId;
    
    // Fecha o menu
    const menu = document.getElementById('msg-global-dropdown');
    if (menu) menu.style.display = 'none';
    activeMenuMsgId = null;

    if (!msgId || !window.activeChatMessages) return;
    const msg = window.activeChatMessages.find(m => m.id === msgId);
    if (!msg) return;

    if (action === 'dados') {
        customAlert(
            `<strong>ID da mensagem:</strong> ${escapeHtml(msg.id)}<br><strong>Data:</strong> ${escapeHtml(msg.timestamp)}<br><strong>Status:</strong> ${escapeHtml(msg.status || 'recebida')}`,
            'Dados da Mensagem'
        );
    } else if (action === 'responder') {
        setReplyTo(msgId);
    } else if (action === 'baixar') {
        // Encontra o caminho do arquivo
        if (msg.message.includes('[FILE:')) {
            let cleanText = msg.message.replace(/\[FILE:.*?\]\n?/, '').replace(/\[CAPTION:.*?\]\n?/, '').trim();
            if (cleanText.startsWith('/api/whatsapp/media/')) {
                // Abre o link do arquivo em nova guia para download
                window.open(cleanText, '_blank');
            } else if (cleanText.startsWith('data:')) {
                // É base64, podemos baixar criando um link temporário
                const link = document.createElement('a');
                link.href = cleanText;
                link.download = msg.message.match(/\[FILE:(.*?)\]/)?.[1] || 'media';
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            }
        }
    } else if (action === 'encaminhar') {
        openForwardModal(msg);
    } else if (action === 'favoritar') {
        alert("Mensagem adicionada aos favoritos!");
    } else if (action === 'apagar') {
        deleteChatMessageForEveryone(msgId);
    }
}

async function reactToMessage(emoji) {
    if (!activeMenuMsgId) return;
    const msgId = activeMenuMsgId;

    // Clicar de novo no mesmo emoji já reagido remove a reação (envia emoji vazio,
    // que é como a API do WhatsApp interpreta "descurtir").
    const alreadyReacted = window.currentReactionsMap?.[msgId] === emoji;
    const emojiToSend = alreadyReacted ? '' : emoji;

    const menu = document.getElementById('msg-global-dropdown');
    if (menu) menu.style.display = 'none';
    activeMenuMsgId = null;

    try {
        const res = await fetch('/api/whatsapp/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                to: window.currentActiveChat.phone,
                message: emojiToSend,
                quoted_id: msgId,
                isReaction: true,
                reactionEmoji: emojiToSend
            })
        });
        const json = await res.json();
        if(!json.success) {
            alert("Erro ao reagir: " + (json.error || "Desconhecido"));
        } else {
            openChat(window.currentActiveChat.phone, window.currentActiveChat.name, true);
        }
    } catch(e) {
        console.error("Erro ao enviar reação:", e);
    }
}

function openForwardModal(msg) {
    pendingForwardMessage = msg;
    
    const previewText = msg.message;
    let cleanText = previewText;
    let fileName = '';
    if (previewText.includes('[FILE:')) {
        const match = previewText.match(/\[FILE:(.*?)\]/);
        if (match && match[1]) {
            fileName = match[1];
            cleanText = previewText.replace(/\[FILE:.*?\]\n?/, '').replace(/\[CAPTION:.*?\]\n?/, '');
        }
    }
    
    const isImage = cleanText.includes('data:image/') || cleanText.includes('.jpg') || cleanText.includes('.jpeg') || cleanText.includes('.png') || cleanText.includes('.gif') || cleanText.includes('.webp');
    const isAudio = cleanText.includes('data:audio/') || cleanText.includes('.mp3') || cleanText.includes('.ogg') || cleanText.includes('.wav') || cleanText.includes('.m4a');
    const isVideo = cleanText.includes('data:video/') || cleanText.includes('.mp4') || cleanText.includes('.mov') || cleanText.includes('.avi') || cleanText.includes('.webm');
    const isDoc = cleanText.includes('data:application/') || cleanText.includes('.pdf') || cleanText.includes('.doc') || cleanText.includes('.docx') || cleanText.includes('.xlsx');

    let preview = '';
    if (isImage) preview = '📷 Foto';
    else if (isAudio) preview = '🎵 Áudio';
    else if (isVideo) preview = '🎥 Vídeo';
    else if (isDoc) preview = `📄 ${fileName || 'Documento'}`;
    else preview = cleanText;

    const previewTextEl = document.getElementById('forward-preview-text');
    if (previewTextEl) previewTextEl.textContent = preview;
    
    const select = document.getElementById('forward-lead-select');
    if (select) {
        select.innerHTML = '';
        
        if (typeof allChatsList !== 'undefined' && Array.isArray(allChatsList)) {
            // Um mesmo contato pode aparecer duas vezes na lista de chats quando o número
            // foi salvo com e sem o 9º dígito (ex: 5561963... e 55619963...). Agrupa por
            // número canônico e resolve o nome real a partir do Kanban quando possível.
            const seen = new Map(); // canonicalPhone -> { phone, name }

            allChatsList.forEach(chat => {
                const canon = canonicalPhoneBR(chat.phone);
                if (!canon) return;

                let name = chat.name;
                if (typeof leads !== 'undefined') {
                    const lead = leads.find(l => isSamePhone(l.telefone, chat.phone));
                    if (lead && lead.nome && !lead.nome.includes('Lead WhatsApp')) name = lead.nome;
                }

                const existing = seen.get(canon);
                if (!existing) {
                    seen.set(canon, { phone: chat.phone, name });
                } else {
                    // Fica com a versão mais completa do telefone (formato correto pra
                    // envio) e com o melhor nome encontrado entre as duas entradas.
                    if (chat.phone.length > existing.phone.length) existing.phone = chat.phone;
                    if (!existing.name && name) existing.name = name;
                }
            });

            seen.forEach(({ phone, name }) => {
                const opt = document.createElement('option');
                opt.value = phone;
                opt.textContent = `${name || 'Sem nome'} (+${phone})`;
                select.appendChild(opt);
            });
        } else {
            const opt = document.createElement('option');
            opt.value = window.currentActiveChat ? window.currentActiveChat.phone : '';
            opt.textContent = window.currentActiveChat ? `${window.currentActiveChat.name} (+${window.currentActiveChat.phone})` : 'Nenhum contato';
            select.appendChild(opt);
        }
    }
    
    const modal = document.getElementById('modalForwardMessage');
    if (modal) modal.style.display = 'flex';
}

function closeForwardModal() {
    const modal = document.getElementById('modalForwardMessage');
    if (modal) modal.style.display = 'none';
    pendingForwardMessage = null;
}

async function submitForwardMessage() {
    if (!pendingForwardMessage) return;
    
    const select = document.getElementById('forward-lead-select');
    const targetPhone = select ? select.value : '';
    if (!targetPhone) {
        alert("Selecione um destinatário.");
        return;
    }
    
    const msgText = pendingForwardMessage.message;
    
    closeForwardModal();
    
    try {
        const res = await fetch('/api/whatsapp/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                to: targetPhone,
                message: msgText
            })
        });
        const json = await res.json();
        if(!json.success) {
            alert("Erro ao encaminhar: " + (json.error || "Desconhecido"));
        } else {
            if (window.currentActiveChat && window.currentActiveChat.phone === targetPhone) {
                openChat(window.currentActiveChat.phone, window.currentActiveChat.name, true);
            } else {
                alert("Mensagem encaminhada com sucesso!");
            }
        }
    } catch (e) {
        alert("Erro na requisição de encaminhamento: " + e.message);
    }
}

function scrollToMessage(msgId) {
    if (!msgId) return;
    const targetBubble = document.getElementById(`msg-bubble-${msgId}`);
    if (targetBubble) {
        // Rola até centralizar a mensagem na tela de forma suave
        targetBubble.scrollIntoView({ behavior: 'smooth', block: 'center' });
        
        // Efeito de piscar (destacar) a mensagem original
        const originalBg = targetBubble.style.background;
        const originalBoxShadow = targetBubble.style.boxShadow;
        const originalTransform = targetBubble.style.transform || 'none';
        
        targetBubble.style.background = 'linear-gradient(145deg, rgba(234, 179, 8, 0.55), rgba(202, 138, 4, 0.55))'; // Efeito amarelado/laranja translúcido
        targetBubble.style.boxShadow = '0 0 25px rgba(234, 179, 8, 0.8)';
        targetBubble.style.transform = 'scale(1.03)';
        
        setTimeout(() => {
            targetBubble.style.background = originalBg;
            targetBubble.style.boxShadow = originalBoxShadow;
            targetBubble.style.transform = originalTransform;
        }, 1000);
    } else {
        console.warn("Mensagem mencionada não encontrada na tela (pode ser antiga e não carregada no histórico local).");
    }
}

function renderQuotedMessage(quotedMsg, quotedDirection, quotedId) {
    if (!quotedMsg) return '';
    
    let cleanText = quotedMsg;
    let fileIcon = '';
    let fileName = '';
    let thumbnail = '';
    let typeLabel = '';

    // Extrai o nome do arquivo se for mídia
    if (quotedMsg.includes('[FILE:')) {
        const match = quotedMsg.match(/\[FILE:(.*?)\]/);
        if (match && match[1]) {
            fileName = match[1];
            cleanText = quotedMsg.replace(/\[FILE:.*?\]\n?/, '').replace(/\[CAPTION:.*?\]\n?/, '');
        }
    }

    const isImage = cleanText.includes('data:image/') || cleanText.includes('.jpg') || cleanText.includes('.jpeg') || cleanText.includes('.png') || cleanText.includes('.gif') || cleanText.includes('.webp');
    const isAudio = cleanText.includes('data:audio/') || cleanText.includes('.mp3') || cleanText.includes('.ogg') || cleanText.includes('.wav') || cleanText.includes('.m4a');
    const isVideo = cleanText.includes('data:video/') || cleanText.includes('.mp4') || cleanText.includes('.mov') || cleanText.includes('.avi') || cleanText.includes('.webm');
    const isDoc = cleanText.includes('data:application/') || cleanText.includes('.pdf') || cleanText.includes('.doc') || cleanText.includes('.docx') || cleanText.includes('.xlsx');

    if (isImage) {
        const idx = cleanText.indexOf('data:image/');
        const src = idx !== -1 ? cleanText.substring(idx) : cleanText;
        typeLabel = '📷 Foto';
        thumbnail = `<img src="${src}" style="width: 36px; height: 36px; object-fit: cover; border-radius: 4px; margin-left: 0.5rem; flex-shrink: 0;" />`;
    } else if (isAudio) {
        typeLabel = '🎵 Áudio';
    } else if (isVideo) {
        typeLabel = '🎥 Vídeo';
        const idx = cleanText.indexOf('data:video/');
        const src = idx !== -1 ? cleanText.substring(idx) : cleanText;
        thumbnail = `<video src="${src}" style="width: 36px; height: 36px; object-fit: cover; border-radius: 4px; margin-left: 0.5rem; flex-shrink: 0;" muted></video>`;
    } else if (isDoc) {
        typeLabel = `📄 ${fileName || 'Documento'}`;
    } else {
        // Mensagem de texto normal
        typeLabel = cleanText.substring(0, 50) + (cleanText.length > 50 ? '...' : '');
    }

    const sender = quotedDirection === 'out' ? 'Você' : (window.currentActiveChat ? window.currentActiveChat.name : 'Cliente');
    const accentColor = quotedDirection === 'out' ? '#eab308' : '#10b981'; // Laranja/Amarelo para você, Verde para cliente

    return `
        <div class="quoted-message-preview" 
             ${quotedId ? `onclick="scrollToMessage('${quotedId}')"` : ''}
             style="
            cursor: pointer;
            background: rgba(0, 0, 0, 0.25);
            border-left: 3px solid ${accentColor};
            border-radius: 6px;
            padding: 0.4rem 0.6rem;
            margin-bottom: 0.5rem;
            font-size: 0.8rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
            opacity: 0.9;
            min-width: 120px;
            max-width: 100%;
            box-sizing: border-box;
        ">
            <div style="display: flex; flex-direction: column; min-width: 0; flex: 1;">
                <span style="font-weight: 600; color: ${accentColor}; font-size: 0.75rem; margin-bottom: 0.15rem;">${sender}</span>
                <span style="opacity: 0.85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; font-size: 0.78rem;">${typeLabel}</span>
            </div>
            ${thumbnail}
        </div>
    `;
}

function renderChatMessageContent(msgText) {
    if (!msgText) return '';
    
    let customFileName = '';
    let cleanMsgText = msgText;

    if (msgText.includes('[FILE:')) {
        const match = msgText.match(/\[FILE:(.*?)\]/);
        if (match && match[1]) {
            customFileName = escapeHtml(match[1]);
            cleanMsgText = msgText.replace(/\[FILE:.*?\]\n?/, '');
        }
    }

    let captionText = '';
    if (msgText.includes('[CAPTION:')) {
        const match = msgText.match(/\[CAPTION:(.*?)\]/s);
        if (match && match[1]) {
            captionText = match[1];
            cleanMsgText = cleanMsgText.replace(/\[CAPTION:.*?\]\n?/, '');
        }
    }

    if (cleanMsgText.includes('data:image/') || cleanMsgText.startsWith('data:image/') || cleanMsgText.includes('.jpg') || cleanMsgText.includes('.jpeg') || cleanMsgText.includes('.png') || cleanMsgText.includes('.gif') || cleanMsgText.includes('.webp')) {
        const idx = cleanMsgText.indexOf('data:image/');
        const src = idx !== -1 ? cleanMsgText.substring(idx) : cleanMsgText;
        const formattedCaption = captionText ? formatWhatsAppFormatting(captionText) : '';
        return `
            <div style="display: flex; flex-direction: column; gap: 0.4rem; max-width: 280px;">
                ${customFileName ? `<div style="font-weight: 600; font-size: 0.8rem; opacity: 0.9;"><i class="fa-solid fa-image"></i> ${customFileName}</div>` : ''}
                <img src="${src}" style="max-width: 100%; max-height: 320px; border-radius: 8px; cursor: pointer; display: block; object-fit: cover;" onclick="window.open(this.src)" title="Clique para expandir" />
                ${formattedCaption ? `<div style="font-size: 0.9rem; line-height: 1.4; margin-top: 0.2rem; color: inherit;">${formattedCaption}</div>` : ''}
            </div>
        `;
    }
    
    if (cleanMsgText.includes('data:audio/') || cleanMsgText.startsWith('data:audio/') || cleanMsgText.includes('.mp3') || cleanMsgText.includes('.ogg') || cleanMsgText.includes('.wav') || cleanMsgText.includes('.m4a')) {
        const idx = cleanMsgText.indexOf('data:audio/');
        const src = idx !== -1 ? cleanMsgText.substring(idx) : cleanMsgText;
        const playerId = 'wf-' + Math.random().toString(36).substring(2, 9);
        
        setTimeout(() => initWaveformPlayer(playerId), 50);

        return `
            <div style="display: flex; flex-direction: column; gap: 0.25rem;">
                <div style="font-weight: 600; font-size: 0.8rem; opacity: 0.9; display: flex; align-items: center; gap: 0.4rem;">
                    <i class="fa-solid fa-microphone" style="color: var(--accent-success);"></i> ${customFileName || 'Áudio Recebido'}
                </div>
                <div class="waveform-player" id="${playerId}" data-audio-src="${src.replace(/"/g, '&quot;')}">
                    <button type="button" class="waveform-play-btn" onclick="toggleWaveformPlay('${playerId}')" title="Reproduzir áudio">
                        <i class="fa-solid fa-play"></i>
                    </button>
                    <div class="waveform-body">
                        <div class="waveform-bars-container" onclick="seekWaveform(event, '${playerId}')" title="Clique para avançar/voltar">
                            ${generateWaveformBarsHTML(playerId)}
                        </div>
                        <div class="waveform-footer">
                            <span class="waveform-time">0:00</span>
                            <button type="button" class="waveform-speed-btn" onclick="cycleWaveformSpeed('${playerId}')">1x</button>
                        </div>
                    </div>
                    <audio id="${playerId}-audio" src="${src}" preload="metadata" style="display: none;"></audio>
                </div>
            </div>
        `;
    }
    
    if (cleanMsgText.includes('data:video/') || cleanMsgText.startsWith('data:video/') || cleanMsgText.includes('.mp4') || cleanMsgText.includes('.mov') || cleanMsgText.includes('.avi') || cleanMsgText.includes('.webm')) {
        const idx = cleanMsgText.indexOf('data:video/');
        const src = idx !== -1 ? cleanMsgText.substring(idx) : cleanMsgText;
        return `
            <div style="display: flex; flex-direction: column; gap: 0.3rem;">
                ${customFileName ? `<div style="font-weight: 600; font-size: 0.8rem; opacity: 0.9;"><i class="fa-solid fa-video"></i> ${customFileName}</div>` : ''}
                <video controls style="max-width: 280px; border-radius: 8px; display: block; margin-top: 0.2rem;"><source src="${src}">Vídeo não suportado.</video>
            </div>
        `;
    }

    if (cleanMsgText.includes('data:application/') || cleanMsgText.includes('data:text/') || cleanMsgText.includes('.pdf') || cleanMsgText.includes('.doc') || cleanMsgText.includes('.docx') || cleanMsgText.includes('.xls') || cleanMsgText.includes('.xlsx') || cleanMsgText.includes('.csv') || cleanMsgText.includes('.txt')) {
        let src = cleanMsgText;
        if (cleanMsgText.includes('data:application/')) {
            const idx = cleanMsgText.indexOf('data:application/');
            src = cleanMsgText.substring(idx);
        } else if (cleanMsgText.includes('data:text/')) {
            const idx = cleanMsgText.indexOf('data:text/');
            src = cleanMsgText.substring(idx);
        }

        const isPdf = src.includes('pdf') || (customFileName && customFileName.toLowerCase().endsWith('.pdf'));
        const iconClass = isPdf ? 'fa-file-pdf' : 'fa-file-lines';
        const iconColor = isPdf ? '#ef4444' : '#3b82f6';
        const docTitle = customFileName || (isPdf ? 'Documento PDF' : 'Arquivo / Documento');
        const downloadName = customFileName || (isPdf ? 'documento.pdf' : 'arquivo');

        return `
            <div style="display: flex; flex-direction: column; gap: 0.5rem; min-width: 210px; max-width: 285px; padding: 0.3rem 0;">
                <div style="display: flex; align-items: center; gap: 0.6rem;">
                    <div style="width: 38px; height: 38px; border-radius: 8px; background: rgba(255, 255, 255, 0.12); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                        <i class="fa-solid ${iconClass}" style="color: ${iconColor}; font-size: 1.3rem;"></i>
                    </div>
                    <div style="overflow: hidden; flex: 1; min-width: 0;">
                        <div style="font-weight: 600; font-size: 0.85rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: inherit;" title="${docTitle.replace(/"/g, '&quot;')}">${docTitle}</div>
                        <div style="font-size: 0.72rem; opacity: 0.75;">Clique para abrir / baixar</div>
                    </div>
                </div>
                <a href="${src.replace(/"/g, '&quot;')}" download="${downloadName.replace(/"/g, '&quot;')}" target="_blank" style="display: flex; align-items: center; justify-content: center; gap: 0.4rem; background: rgba(255, 255, 255, 0.15); color: inherit; text-decoration: none; padding: 0.45rem 0.75rem; border-radius: 8px; font-size: 0.78rem; font-weight: 600; transition: 0.2s; border: 1px solid rgba(255, 255, 255, 0.2);" onmouseover="this.style.background='rgba(255,255,255,0.25)'" onmouseout="this.style.background='rgba(255,255,255,0.15)'">
                    <i class="fa-solid fa-download"></i> Baixar / Visualizar
                </a>
            </div>
        `;
    }

    return formatWhatsAppFormatting(cleanMsgText);
}

// === HELPER DE FORMATAÇÃO DE TEXTO DO WHATSAPP (B, I, S) ===
function formatChatText(type) {
    const input = document.getElementById('chat-input-text');
    if (!input) return;

    const start = input.selectionStart || 0;
    const end = input.selectionEnd || 0;
    const val = input.value;
    const selected = val.substring(start, end);

    let symbol = '*';
    if (type === 'italic') symbol = '_';
    if (type === 'strikethrough') symbol = '~';

    let replacement = '';
    if (selected) {
        replacement = `${symbol}${selected}${symbol}`;
    } else {
        replacement = `${symbol}texto${symbol}`;
    }

    input.value = val.substring(0, start) + replacement + val.substring(end);
    input.focus();
    
    if (selected) {
        input.setSelectionRange(start, start + replacement.length);
    } else {
        input.setSelectionRange(start + symbol.length, start + symbol.length + 5);
    }
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatWhatsAppFormatting(text) {
    if (!text) return '';

    // Escapar tags HTML para segurança
    let html = String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    // Code block ```texto```
    html = html.replace(/```([^`]+)```/g, '<code style="background: rgba(0,0,0,0.3); padding: 0.2rem 0.4rem; border-radius: 4px; font-family: monospace; font-size: 0.85rem;">$1</code>');

    // Negrito *texto*
    html = html.replace(/(^|[^\w*])\*([^\s*](?:[^*]*[^\s*])?)\*([^\w*]|$)/g, '$1<strong>$2</strong>$3');

    // Itálico _texto_
    html = html.replace(/(^|[^\w_])_([^\s_](?:[^_]*[^\s_])?)_([^\w_]|$)/g, '$1<em>$2</em>$3');

    // Tachado ~texto~
    html = html.replace(/(^|[^\w~])~([^\s~](?:[^~]*[^\s~])?)~([^\w~]|$)/g, '$1<del style="opacity: 0.85;">$2</del>$3');

    // Quebras de linha
    html = html.replace(/\n/g, '<br>');

    return html;
}

function renderStatusIcon(status) {
    if (!status || status === 'sent') {
        return `<i class="fa-solid fa-check" style="color: var(--text-muted); font-size: 0.75rem;" title="Enviada"></i>`;
    }
    if (status === 'delivered') {
        return `<i class="fa-solid fa-check-double" style="color: var(--text-muted); font-size: 0.75rem;" title="Entregue"></i>`;
    }
    if (status === 'read') {
        return `<i class="fa-solid fa-check-double" style="color: #34d399; font-size: 0.75rem;" title="Lida (Visualizada)"></i>`;
    }
    if (status === 'failed') {
        return `<i class="fa-solid fa-circle-exclamation" style="color: var(--accent-danger); font-size: 0.75rem;" title="Falha ao enviar"></i>`;
    }
    return `<i class="fa-solid fa-check" style="color: var(--text-muted); font-size: 0.75rem;"></i>`;
}

function getMessagePreviewText(msgText) {
    if (!msgText) return '';
    let customFileName = '';
    if (msgText.includes('[FILE:')) {
        const match = msgText.match(/\[FILE:(.*?)\]/);
        if (match && match[1]) customFileName = match[1];
    }

    if (msgText.includes('data:image/')) return customFileName ? `📷 ${customFileName}` : '📷 [Imagem]';
    if (msgText.includes('data:audio/')) return customFileName ? `🎤 ${customFileName}` : '🎤 [Áudio]';
    if (msgText.includes('data:video/')) return customFileName ? `🎥 ${customFileName}` : '🎥 [Vídeo]';
    if (msgText.includes('data:application/') || msgText.includes('data:text/') || msgText.includes('.pdf') || msgText.includes('.doc') || msgText.includes('.xlsx')) {
        return customFileName ? `📄 ${customFileName}` : '📄 [Documento / PDF]';
    }
    return msgText.replace(/\[FILE:.*?\]\n?/, '');
}

let allChatsList = [];

// ==========================================
// FILTROS DE CONVERSA (Todos / Não lidos / Favoritos / Contatos / Grupos / Rascunhos)
// ==========================================
let activeChatFilter = 'todos';

// ==========================================
// PREFERÊNCIAS POR CONVERSA (favorito, fixado, arquivado, não lido manual)
// Guardadas no servidor (crm_chat_settings) — funciona igual pra qualquer
// atendente/dispositivo, ao contrário do antigo favorito que ficava só no
// localStorage de cada navegador.
// ==========================================
let chatSettingsMap = {}; // canonicalPhone -> { is_favorite, is_pinned, is_archived, marked_unread }

async function loadChatSettings() {
    try {
        const res = await fetch('/api/chat-settings');
        const json = await res.json();
        const map = {};
        (json.items || []).forEach(row => { map[row.phone] = row; });
        chatSettingsMap = map;
        if (typeof allChatsList !== 'undefined' && Array.isArray(allChatsList) && allChatsList.length > 0) {
            reapplyChatFilters();
        }
    } catch (e) {
        console.error('Erro ao carregar preferências de conversas:', e);
    }
}

function getChatSetting(phone, field) {
    const row = chatSettingsMap[canonicalPhoneBR(phone)];
    return !!(row && Number(row[field]) === 1);
}

function isFavoriteChat(phone) { return getChatSetting(phone, 'is_favorite'); }
function isPinnedChat(phone) { return getChatSetting(phone, 'is_pinned'); }
function isArchivedChat(phone) { return getChatSetting(phone, 'is_archived'); }
function isMarkedUnreadChat(phone) { return getChatSetting(phone, 'marked_unread'); }

async function setChatSetting(phone, field, value) {
    const key = canonicalPhoneBR(phone);
    if (!chatSettingsMap[key]) chatSettingsMap[key] = { phone: key, is_favorite: 0, is_pinned: 0, is_archived: 0, marked_unread: 0 };
    chatSettingsMap[key][field] = value ? 1 : 0;
    reapplyChatFilters(); // atualiza a UI já, otimista

    try {
        const res = await fetch(`/api/chat-settings/${encodeURIComponent(key)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ field, value: value ? 1 : 0 })
        });
        if (!res.ok) throw new Error('Falha ao salvar');
    } catch (e) {
        console.error('Erro ao salvar preferência de conversa:', e);
        if (typeof showToast === 'function') showToast('Não foi possível salvar essa preferência.', 'danger');
    }
}

function toggleFavoriteChat(phone) {
    setChatSetting(phone, 'is_favorite', !isFavoriteChat(phone));
}

function togglePinnedChat(phone) {
    setChatSetting(phone, 'is_pinned', !isPinnedChat(phone));
}

function toggleArchivedChat(phone) {
    setChatSetting(phone, 'is_archived', !isArchivedChat(phone));
}

function toggleMarkedUnreadChat(phone) {
    setChatSetting(phone, 'marked_unread', !isMarkedUnreadChat(phone));
}

// ==========================================
// MENU DE CONTEXTO (botão direito numa conversa)
// ==========================================
function showChatContextMenu(event, phone, displayName) {
    event.preventDefault();
    const menu = document.getElementById('chat-context-menu');
    if (!menu) return;

    const unread = isMarkedUnreadChat(phone);
    const fav = isFavoriteChat(phone);
    const pinned = isPinnedChat(phone);
    const archived = isArchivedChat(phone);

    const item = (icon, label, onclick, danger = false) => `
        <div onclick="${onclick}" style="padding: 0.6rem 1rem; cursor: pointer; display: flex; align-items: center; gap: 0.7rem; font-size: 0.85rem; color: ${danger ? 'var(--accent-danger)' : 'var(--text-main)'}; transition: 0.15s;"
            onmouseover="this.style.background='rgba(255,255,255,0.08)'" onmouseout="this.style.background='transparent'">
            <i class="${icon}" style="width: 16px; text-align: center;"></i> ${label}
        </div>`;

    menu.innerHTML = [
        item(unread ? 'fa-solid fa-envelope-open' : 'fa-solid fa-envelope', unread ? 'Marcar como lida' : 'Marcar como não lida', `hideChatContextMenu(); toggleMarkedUnreadChat('${phone}')`),
        item(fav ? 'fa-solid fa-star' : 'fa-regular fa-star', fav ? 'Remover dos favoritos' : 'Adicionar aos favoritos', `hideChatContextMenu(); toggleFavoriteChat('${phone}')`),
        item('fa-solid fa-thumbtack', pinned ? 'Desafixar conversa' : 'Fixar conversa', `hideChatContextMenu(); togglePinnedChat('${phone}')`),
        '<div style="height: 1px; background: var(--border-color); margin: 0.3rem 0;"></div>',
        item(archived ? 'fa-solid fa-box-open' : 'fa-solid fa-box-archive', archived ? 'Desarquivar conversa' : 'Arquivar conversa', `hideChatContextMenu(); toggleArchivedChat('${phone}')`),
        item('fa-solid fa-trash-can', 'Apagar conversa', `hideChatContextMenu(); deleteConversation('${phone}', ${JSON.stringify(displayName)})`, true)
    ].join('');

    const margin = 8;
    let left = event.clientX;
    let top = event.clientY;
    menu.style.display = 'block';

    requestAnimationFrame(() => {
        const rect = menu.getBoundingClientRect();
        if (left + rect.width > window.innerWidth - margin) left = window.innerWidth - rect.width - margin;
        if (top + rect.height > window.innerHeight - margin) top = window.innerHeight - rect.height - margin;
        menu.style.left = Math.max(margin, Math.round(left)) + 'px';
        menu.style.top = Math.max(margin, Math.round(top)) + 'px';
    });
}

function hideChatContextMenu() {
    const menu = document.getElementById('chat-context-menu');
    if (menu) menu.style.display = 'none';
}

document.addEventListener('click', (e) => {
    const menu = document.getElementById('chat-context-menu');
    if (menu && menu.style.display === 'block' && !menu.contains(e.target)) {
        hideChatContextMenu();
    }
});
document.addEventListener('contextmenu', (e) => {
    const menu = document.getElementById('chat-context-menu');
    if (menu && menu.style.display === 'block' && !e.target.closest('.chat-row')) {
        hideChatContextMenu();
    }
});

function getChatDraftsMap() {
    try {
        return JSON.parse(localStorage.getItem('crm_chat_drafts') || '{}');
    } catch (e) {
        return {};
    }
}

function getChatDraft(phone) {
    const map = getChatDraftsMap();
    return map[canonicalPhoneBR(phone)] || '';
}

function setChatDraft(phone, text) {
    const map = getChatDraftsMap();
    const key = canonicalPhoneBR(phone);
    if (text && text.trim()) {
        map[key] = text;
    } else {
        delete map[key];
    }
    localStorage.setItem('crm_chat_drafts', JSON.stringify(map));
}

function clearChatDraft(phone) {
    setChatDraft(phone, '');
}

function saveChatDraftFromInput() {
    if (!window.currentActiveChat || !window.currentActiveChat.phone) return;
    const input = document.getElementById('chat-input-text');
    setChatDraft(window.currentActiveChat.phone, input ? input.value : '');
}

// A API oficial do WhatsApp Business (Cloud API) usada aqui não envia/recebe mensagens de
// grupo — só conversas individuais. Ainda assim, se algum número vier com formato de grupo
// (JID terminando em @g.us ou anormalmente longo), ele é tratado como grupo pra não sumir.
function isGroupChat(chat) {
    const raw = String(chat.phone || '');
    if (raw.includes('g.us')) return true;
    const digits = raw.replace(/\D/g, '');
    return digits.length > 15;
}

function setChatFilter(mode) {
    activeChatFilter = mode;
    document.querySelectorAll('.chat-filter-menu-item').forEach(el => {
        el.classList.toggle('active', el.dataset.filter === mode);
    });

    const toggleBtn = document.getElementById('chat-filter-toggle-btn');
    const dot = document.getElementById('chat-filter-active-dot');
    if (toggleBtn) toggleBtn.classList.toggle('chat-filter-toggle-btn-active', mode !== 'todos');
    if (dot) dot.style.display = mode !== 'todos' ? 'block' : 'none';

    const menu = document.getElementById('chat-filter-menu');
    if (menu) menu.style.display = 'none';

    reapplyChatFilters();
}

function toggleChatFilterMenu(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('chat-filter-menu');
    const btn = document.getElementById('chat-filter-toggle-btn');
    if (!menu || !btn) return;

    if (menu.style.display === 'block') {
        menu.style.display = 'none';
        return;
    }

    // Posiciona via JS (position: fixed) pra escapar do overflow:hidden da sidebar do chat,
    // que senão corta o menu — mesmo esquema já usado no dropdown de opções da mensagem.
    const rect = btn.getBoundingClientRect();
    const menuWidth = 220;
    let left = rect.right - menuWidth;
    if (left < 8) left = 8;
    let top = rect.bottom + 6;
    if (top + 300 > window.innerHeight) top = rect.top - 6 - 300;

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.display = 'block';
}

document.addEventListener('click', (e) => {
    const menu = document.getElementById('chat-filter-menu');
    const btn = document.getElementById('chat-filter-toggle-btn');
    if (menu && menu.style.display === 'block' && !menu.contains(e.target) && (!btn || !btn.contains(e.target))) {
        menu.style.display = 'none';
    }
});

// Reaplica busca por texto + filtro de categoria ativos — usar sempre no lugar de
// renderContactsList(allChatsList) direto, senão o filtro ativo é perdido no re-render.
function reapplyChatFilters() {
    const searchInput = document.getElementById('chat-search-input');
    filterChatContacts(searchInput ? searchInput.value : '');
}

function filterChatContacts(query) {
    const q = (query || '').toLowerCase().trim();
    if (!allChatsList) return;

    let filtered = allChatsList;

    if (q) {
        filtered = filtered.filter(chat => {
            const name = (chat.nome || '').toLowerCase();
            const phone = (chat.phone || '').toLowerCase();
            const msg = (chat.message || '').toLowerCase();

            let tagNames = '';
            if (typeof leads !== 'undefined' && Array.isArray(leads)) {
                const lead = leads.find(l => isSamePhone(l.telefone, chat.phone));
                if (lead && lead.tags) {
                    const tagIds = parseLeadTags(lead.tags);
                    const availableTags = getAvailableTags();
                    tagNames = tagIds.map(id => {
                        const found = availableTags.find(t => t.id === id);
                        return found ? found.label : id;
                    }).join(' ').toLowerCase();
                }
            }

            return name.includes(q) || phone.includes(q) || msg.includes(q) || tagNames.includes(q);
        });
    }

    if (activeChatFilter === 'archived') {
        filtered = filtered.filter(chat => isArchivedChat(chat.phone));
    } else {
        // Conversa arquivada some de todos os outros filtros — só aparece
        // de novo entrando explicitamente em "Arquivadas".
        filtered = filtered.filter(chat => !isArchivedChat(chat.phone));

        if (activeChatFilter === 'unread') {
            filtered = filtered.filter(chat => Number(chat.unread_count || 0) > 0 || isMarkedUnreadChat(chat.phone));
        } else if (activeChatFilter === 'favorites') {
            filtered = filtered.filter(chat => isFavoriteChat(chat.phone));
        } else if (activeChatFilter === 'contacts') {
            filtered = filtered.filter(chat => !isGroupChat(chat));
        } else if (activeChatFilter === 'groups') {
            filtered = filtered.filter(chat => isGroupChat(chat));
        } else if (activeChatFilter === 'drafts') {
            filtered = filtered.filter(chat => !!getChatDraft(chat.phone));
        }
    }

    // Fixadas sempre no topo, dentro da ordenação por atividade recente que já vem da API.
    filtered = [...filtered].sort((a, b) => {
        const pinnedDiff = (isPinnedChat(b.phone) ? 1 : 0) - (isPinnedChat(a.phone) ? 1 : 0);
        return pinnedDiff;
    });

    renderContactsList(filtered);
}

// ==========================================
// APAGAR CONVERSA(S) DO WHATSAPP
// ==========================================
let chatSelectMode = false;
let selectedChatPhones = new Set();

function toggleChatSelectMode() {
    chatSelectMode = !chatSelectMode;
    selectedChatPhones.clear();

    const bar = document.getElementById('chat-selection-bar');
    if (bar) bar.style.display = chatSelectMode ? 'flex' : 'none';

    const toggleBtn = document.getElementById('chat-select-toggle-btn');
    if (toggleBtn) {
        toggleBtn.innerHTML = chatSelectMode
            ? '<i class="fa-solid fa-xmark"></i> Cancelar'
            : '<i class="fa-regular fa-square-check"></i> Selecionar';
    }

    updateChatSelectionBar();
    reapplyChatFilters();
}

function toggleChatSelection(phone) {
    if (selectedChatPhones.has(phone)) selectedChatPhones.delete(phone);
    else selectedChatPhones.add(phone);
    updateChatSelectionBar();
    reapplyChatFilters();
}

function updateChatSelectionBar() {
    const countEl = document.getElementById('chat-selection-count');
    const deleteBtn = document.getElementById('chat-selection-delete-btn');
    const n = selectedChatPhones.size;
    if (countEl) countEl.textContent = `${n} selecionada(s)`;
    if (deleteBtn) {
        deleteBtn.disabled = n === 0;
        deleteBtn.style.opacity = n === 0 ? '0.5' : '1';
    }
}

// Volta a área principal de chat pro estado vazio (usado quando a conversa aberta é apagada,
// ou quando o atendente fecha a conversa manualmente com ESC). Não força a liberação da
// trava de atendimento — ela expira sozinha por inatividade, igual já acontece ao trocar de conversa.
function closeActiveChat() {
    stopLeadLockRenewal();
    applyChatLockUI(false);
    window.currentActiveChat = null;
    window.activeChatMessages = null;
    const empty = document.getElementById('chat-empty-state');
    const header = document.getElementById('chat-active-header');
    const messages = document.getElementById('chat-active-messages');
    const input = document.getElementById('chat-active-input');
    const leadPanel = document.getElementById('chat-lead-panel');
    if (empty) empty.style.display = 'flex';
    if (header) header.style.display = 'none';
    if (messages) messages.style.display = 'none';
    if (input) input.style.display = 'none';
    if (leadPanel) leadPanel.style.display = 'none';
    // mobile: volta pra lista de conversas
    document.getElementById('view-chat')?.classList.remove('chat-open', 'lead-open');
    if (window.chatPollingInterval) {
        clearInterval(window.chatPollingInterval);
        window.chatPollingInterval = null;
    }
    if (typeof allChatsList !== 'undefined' && Array.isArray(allChatsList) && typeof renderContactsList === 'function') {
        reapplyChatFilters();
    }
}

async function deleteConversation(phone, displayName) {
    if (!await customConfirm(`Apagar toda a conversa com ${displayName}? Essa ação não pode ser desfeita.`, 'Apagar Conversa')) return;
    try {
        const res = await fetch(`/api/whatsapp/chat/${encodeURIComponent(phone)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json()).error || 'Erro ao apagar conversa');

        if (window.currentActiveChat && window.currentActiveChat.phone === phone) closeActiveChat();
        if (typeof showToast === 'function') showToast('Conversa apagada.', 'success');
        await loadChats();
    } catch (e) {
        if (typeof showToast === 'function') showToast(e.message, 'danger'); else alert(e.message);
    }
}

async function deleteSelectedConversations() {
    const phones = Array.from(selectedChatPhones);
    if (phones.length === 0) return;

    if (!await customConfirm(`Apagar ${phones.length} conversa(s) selecionada(s)? Essa ação não pode ser desfeita.`, 'Apagar Conversas')) return;

    try {
        const res = await fetch('/api/whatsapp/chats', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phones })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Erro ao apagar conversas');

        if (window.currentActiveChat && phones.includes(window.currentActiveChat.phone)) closeActiveChat();
        if (typeof showToast === 'function') showToast(`${phones.length} conversa(s) apagada(s).`, 'success');

        chatSelectMode = false;
        selectedChatPhones.clear();
        const bar = document.getElementById('chat-selection-bar');
        if (bar) bar.style.display = 'none';
        const toggleBtn = document.getElementById('chat-select-toggle-btn');
        if (toggleBtn) toggleBtn.innerHTML = '<i class="fa-regular fa-square-check"></i> Selecionar';

        await loadChats();
    } catch (e) {
        if (typeof showToast === 'function') showToast(e.message, 'danger'); else alert(e.message);
    }
}

function renderContactsList(chats) {
    const container = document.getElementById('chat-contacts-list');
    if (!container) return;

    if (!chats || chats.length === 0) {
        const emptyMessages = {
            unread: 'Nenhuma conversa não lida.',
            favorites: 'Nenhum favorito ainda. Passe o mouse numa conversa e clique na estrela pra favoritar.',
            contacts: 'Nenhum contato encontrado.',
            groups: 'Sem conversas em grupo. A API do WhatsApp Business usada aqui não suporta grupos.',
            drafts: 'Nenhum rascunho salvo.',
            archived: 'Nenhuma conversa arquivada.'
        };
        const msg = emptyMessages[activeChatFilter] || 'Nenhuma conversa encontrada.';
        container.innerHTML = `<div style="padding: 2rem; text-align: center; color: var(--text-muted);">${msg}</div>`;
        return;
    }

    // Desduplicar: agrupar chats com o mesmo número canônico, mantendo o mais recente
    const seen = new Map();
    chats.forEach(chat => {
        const key = canonicalPhoneBR(chat.phone);
        if (!seen.has(key)) {
            seen.set(key, { ...chat, phone: key || chat.phone });
        } else {
            // Mantém o que tiver last_interaction mais recente
            const existing = seen.get(key);
            const existingTs = existing.last_interaction || existing.timestamp || '';
            const newTs = chat.last_interaction || chat.timestamp || '';
            if (newTs > existingTs) {
                seen.set(key, { ...chat, phone: key || chat.phone });
            } else {
                existing.unread_count = (Number(existing.unread_count) || 0) + (Number(chat.unread_count) || 0);
            }
        }
    });
    chats = Array.from(seen.values());

    let html = '';
    chats.forEach(chat => {
        const isActive = window.currentActiveChat && window.currentActiveChat.phone === chat.phone ? 'background: rgba(16, 185, 129, 0.1); border-left: 4px solid var(--accent-success);' : 'border-bottom: 1px solid var(--border-color);';
        
        const timeString = formatChatTime(chat.last_interaction);
        const displayName = chat.nome || ('Contato ' + chat.phone);
        const preview = getMessagePreviewText(chat.message);
        const statusIcon = chat.direction === 'out' ? renderStatusIcon(chat.status) + ' ' : '';

        // Buscar etiquetas associadas ao lead + trava de atendimento (evita atropelo entre atendentes)
        let leadTagsHTML = '';
        let lockBadgeHTML = '';
        let aiBadgeHTML = '';
        if (typeof leads !== 'undefined' && Array.isArray(leads)) {
            const phone = chat.phone;
            const lead = leads.find(l => isSamePhone(l.telefone, phone));
            if (lead && Number(lead.ai_enabled) !== 0 && ['col-entrada', 'col-contatado'].includes(lead.column)) {
                aiBadgeHTML = `<span title="IA respondendo automaticamente" style="display: inline-flex; align-items: center; font-size: 0.7rem; margin-left: 4px;">🤖</span>`;
            }
            const tagIds = (lead && lead.tags) ? parseLeadTags(lead.tags) : [];

            // "Aguardando Resposta" calculado na hora (não fica salvo em lugar
            // nenhum) — sempre que a última mensagem for do paciente e já
            // fizer mais de 5 minutos sem ninguém (humano ou IA) ter
            // respondido. Reaproveita a etiqueta padrão "aguardando" já
            // existente, e não duplica se ela já tiver sido aplicada manualmente.
            const lastMsgTs = parseD1TimestampMs(chat.last_timestamp || chat.timestamp || chat.last_interaction);
            const lastMsgDirection = chat.last_direction || chat.direction;
            const isAutoWaiting = lastMsgDirection === 'in' && lastMsgTs && (Date.now() - lastMsgTs) > 5 * 60 * 1000;
            const displayTagIds = (isAutoWaiting && !tagIds.includes('aguardando')) ? [...tagIds, 'aguardando'] : tagIds;

            if (displayTagIds.length > 0) {
                leadTagsHTML = `<div style="display: flex; gap: 0.3rem; flex-wrap: wrap; margin-top: 0.35rem;">` +
                    displayTagIds.map(tId => getTagBadgeHTML(tId)).join('') +
                    `</div>`;
            }
            if (lead && lead.owner_id) {
                const currentUser = (typeof loggedUser !== 'undefined' && loggedUser) ? loggedUser.username : null;
                const isOtherOwner = lead.owner_id !== currentUser;
                const assignedAtMs = parseD1TimestampMs(lead.assigned_at);
                const isStale = !assignedAtMs || (Date.now() - assignedAtMs) > LEAD_LOCK_TIMEOUT_MS;
                if (isOtherOwner && !isStale) {
                    const ownerName = getLockOwnerDisplayName(lead.owner_id);
                    lockBadgeHTML = `<span title="Em atendimento por ${escapeHtml(ownerName)}" style="display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.68rem; font-weight: 600; color: #fbbf24; background: rgba(251, 191, 36, 0.12); border: 1px solid rgba(251, 191, 36, 0.35); padding: 0.1rem 0.5rem; border-radius: 10px; margin-left: 6px; white-space: nowrap;"><i class="fa-solid fa-lock" style="font-size: 0.6rem;"></i>${escapeHtml(ownerName)}</span>`;
                }
            }
        }

        const onlineInfo = getLeadOnlineStatus(chat.last_timestamp || chat.timestamp, chat.last_direction || chat.direction);
        const avatarHTML = renderAvatarHTML(displayName, null, onlineInfo.statusClass, 40);
        
        const unreadCount = Number(chat.unread_count || 0);
        const markedUnread = isMarkedUnreadChat(chat.phone);

        const unreadBadgeHTML = unreadCount > 0
            ? `<span style="background: var(--accent-success, #10b981); color: #ffffff; font-size: 0.72rem; font-weight: 700; border-radius: 12px; padding: 0.15rem 0.55rem; min-width: 20px; text-align: center; box-shadow: none; border: 1px solid rgba(255,255,255,0.2);" title="${unreadCount} mensagem(ns) não lida(s)">${unreadCount}</span>`
            : (markedUnread ? `<span title="Marcada como não lida" style="width: 10px; height: 10px; border-radius: 50%; background: var(--accent-success, #10b981); display: inline-block; box-shadow: none;"></span>` : '');

        const pinnedHTML = isPinnedChat(chat.phone)
            ? `<i class="fa-solid fa-thumbtack" title="Conversa fixada" style="font-size: 0.7rem; color: var(--text-muted); transform: rotate(45deg); flex-shrink: 0;"></i>`
            : '';

        const isSelected = chatSelectMode && selectedChatPhones.has(chat.phone);
        const rowClickHandler = chatSelectMode
            ? `toggleChatSelection('${chat.phone}')`
            : `openChat('${chat.phone}', '${displayName.replace(/'/g, "\\'")}')`;
        const checkboxHTML = chatSelectMode
            ? `<i class="fa-solid ${isSelected ? 'fa-circle-check' : 'fa-circle'}" style="font-size: 1.2rem; color: ${isSelected ? 'var(--accent-success)' : 'var(--text-muted)'}; flex-shrink: 0;"></i>`
            : '';
        const deleteBtnHTML = !chatSelectMode
            ? `<button type="button" onclick="event.stopPropagation(); deleteConversation('${chat.phone}', '${displayName.replace(/'/g, "\\'")}')" title="Apagar conversa" class="chat-row-delete-btn" style="background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 0.3rem; border-radius: 6px; flex-shrink: 0;"><i class="fa-solid fa-trash-can"></i></button>`
            : '';

        const isFav = isFavoriteChat(chat.phone);
        const favoriteBtnHTML = !chatSelectMode
            ? `<button type="button" onclick="event.stopPropagation(); toggleFavoriteChat('${chat.phone}')" title="${isFav ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}" class="chat-row-favorite-btn${isFav ? ' is-favorite' : ''}"><i class="fa-${isFav ? 'solid' : 'regular'} fa-star"></i></button>`
            : '';

        const draftText = getChatDraft(chat.phone);
        const previewLineHTML = draftText
            ? `<span style="color: var(--accent-danger, #f87171); font-weight: 600;">Rascunho:</span><span>${escapeHtml(draftText)}</span>`
            : `${statusIcon}<span>${preview}</span>`;

        const archivedOpacity = isArchivedChat(chat.phone) ? 'opacity: 0.65;' : '';

        html += `
            <div class="chat-row" oncontextmenu="showChatContextMenu(event, '${chat.phone}', '${displayName.replace(/'/g, "\\'")}')" style="display: flex; align-items: center; gap: 0.9rem; padding: 0.9rem 1.2rem; cursor: pointer; transition: 0.2s; ${archivedOpacity} ${isSelected ? 'background: rgba(16, 185, 129, 0.08);' : isActive}" onclick="${rowClickHandler}" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='${isSelected ? 'rgba(16, 185, 129, 0.08)' : (isActive.includes('rgba') ? 'rgba(16, 185, 129, 0.1)' : 'transparent')}'">
                ${checkboxHTML}
                ${avatarHTML}
                <div style="flex: 1; min-width: 0;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.15rem;">
                        <span style="display: flex; align-items: center; gap: 0.35rem; min-width: 0; overflow: hidden;">
                            ${pinnedHTML}
                            <strong style="color: var(--text-main); font-size: 0.92rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${displayName}</strong>
                            ${aiBadgeHTML}
                            ${lockBadgeHTML}
                        </span>
                        <div style="display: flex; align-items: center; gap: 0.4rem; flex-shrink: 0; margin-left: 6px;">
                            <span style="font-size: 0.72rem; color: var(--text-muted);">${timeString}</span>
                            ${unreadBadgeHTML}
                        </div>
                    </div>
                    <div style="font-size: 0.78rem; color: var(--text-muted); margin-bottom: 0.2rem;">
                        <i class="fa-solid fa-phone" style="font-size: 0.68rem;"></i> +${chat.phone}
                    </div>
                    <div style="font-size: 0.82rem; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 0.3rem;">
                        ${previewLineHTML}
                    </div>
                    ${leadTagsHTML}
                </div>
                ${favoriteBtnHTML}
                ${deleteBtnHTML}
            </div>
        `;
    });
    container.innerHTML = html;

    // Atualiza badge de mensagens nao lidas na aba Chat WhatsApp
    const totalUnread = (chats || []).reduce(function(sum, c) { return sum + Number(c.unread_count || 0); }, 0);
    const badge = document.getElementById('chat-unread-badge');
    if (badge) {
        if (totalUnread > 0) {
            badge.style.display = 'inline-block';
            badge.innerText = totalUnread > 99 ? '99+' : String(totalUnread);
        } else {
            badge.style.display = 'none';
        }
    }
}

let lastSeenMaxMsgId = null;
let hasInitializedChatCheck = false;

function playNotificationSound() {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        const ctx = new AudioContext();
        
        const now = ctx.currentTime;
        
        // Tom 1 (E5 - 659.25 Hz)
        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(659.25, now);
        gain1.gain.setValueAtTime(0.18, now);
        gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        osc1.start(now);
        osc1.stop(now + 0.25);

        // Tom 2 (A5 - 880 Hz)
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(880, now + 0.12);
        gain2.gain.setValueAtTime(0.22, now + 0.12);
        gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.start(now + 0.12);
        osc2.stop(now + 0.5);
    } catch(e) {}
}

function showChatNotificationDot() {
    // Legado — o badge agora é atualizado automaticamente pelo renderContactsList
    // Mantido para não quebrar chamadas existentes
}

function hideChatNotificationDot() {
    // Legado — o badge agora é atualizado automaticamente pelo renderContactsList
    // Mantido para não quebrar chamadas existentes
}

async function loadChats(silent = false) {
    if (!silent) document.getElementById('chat-contacts-list').innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--text-muted);"><span class="amicro-loader"><span></span><span></span><span></span></span> Carregando conversas...</div>';
    
    try {
        const res = await fetch('/api/whatsapp/chats');
        const json = await res.json();
        
        if (json.success) {
            const newChats = json.data || [];
            
            // Injeta o nome do lead se existir no Kanban
            newChats.forEach(chat => {
                if (typeof leads !== 'undefined' && Array.isArray(leads)) {
                    const lead = leads.find(l => isSamePhone(l.telefone, chat.phone));
                    if (lead && lead.nome) {
                        chat.nome = lead.nome;
                    }
                }
            });
            
            // Notificação Sonora e Bolinha Verde ao receber nova mensagem
            if (newChats.length > 0) {
                let currentMaxMsgId = newChats[0].last_interaction + '_' + newChats[0].message;
                
                if (!hasInitializedChatCheck) {
                    lastSeenMaxMsgId = currentMaxMsgId;
                    hasInitializedChatCheck = true;
                } else if (currentMaxMsgId && currentMaxMsgId !== lastSeenMaxMsgId) {
                    const topChat = newChats[0];
                    if (topChat && (topChat.direction === 'in' || topChat.last_direction === 'in')) {
                        playNotificationSound();
                        showChatNotificationDot();
                    }
                    lastSeenMaxMsgId = currentMaxMsgId;
                }
            }

            allChatsList = newChats;
            reapplyChatFilters();
        }
    } catch(e) {
        if(!silent) document.getElementById('chat-contacts-list').innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--accent-danger);">Erro ao carregar conversas.</div>';
    }
}

function updateChatStageUI(columnId) {
    const labelEl = document.getElementById('chat-stage-label');
    const badgeEl = document.getElementById('chat-current-stage-badge');
    
    const stageMap = {
        'col-entrada': { name: '📥 Novos Leads', border: 'rgba(96, 165, 250, 0.35)', color: '#60a5fa' },
        'col-contatado': { name: '💬 Em Atendimento', border: 'rgba(129, 140, 248, 0.35)', color: '#818cf8' },
        'col-orcado': { name: '📄 Orçado', border: 'rgba(167, 139, 250, 0.35)', color: '#a78bfa' },
        'col-agendado': { name: '📅 Agendado', border: 'rgba(52, 211, 153, 0.35)', color: '#34d399' },
        'col-ganho': { name: '✅ Ganho', border: 'rgba(16, 185, 129, 0.35)', color: '#10b981' },
        'col-perdido': { name: '❌ Não Fechou', border: 'rgba(248, 113, 113, 0.35)', color: '#f87171' }
    };

    const current = stageMap[columnId] || stageMap['col-entrada'];
    if (labelEl) labelEl.textContent = current.name;
    if (badgeEl) {
        badgeEl.style.color = current.color;
        badgeEl.style.borderColor = current.border;
    }
}

function toggleStageMenu(e) {
    if (e) e.stopPropagation();
    const popup = document.getElementById('stage-menu-popup');
    if (!popup) return;
    popup.style.display = (popup.style.display === 'block') ? 'none' : 'block';
}

function selectStageOption(columnId) {
    const popup = document.getElementById('stage-menu-popup');
    if (popup) popup.style.display = 'none';
    if (typeof changeLeadStatusFromChat === 'function') {
        changeLeadStatusFromChat(columnId);
    }
    updateChatStageUI(columnId);
}

const DEFAULT_TAGS = [
    { id: 'urgente', label: '🔥 Urgente', bg: 'rgba(239, 68, 68, 0.15)', color: '#f87171', border: '#ef4444' },
    { id: 'vip', label: '⭐ VIP', bg: 'rgba(245, 158, 11, 0.15)', color: '#fbbf24', border: '#f59e0b' },
    { id: 'aguardando', label: '⏳ Aguardando Resposta', bg: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa', border: '#3b82f6' },
    { id: 'interessado', label: '💉 Interesse em Procedimento', bg: 'rgba(168, 85, 247, 0.15)', color: '#c084fc', border: '#a855f7' },
    { id: 'orcamento', label: '📄 Orçamento Enviado', bg: 'rgba(16, 185, 129, 0.15)', color: '#34d399', border: '#10b981' },
    { id: 'retorno', label: '🔄 Retorno', bg: 'rgba(249, 115, 22, 0.15)', color: '#fb923c', border: '#f97316' }
];

// As etiquetas ficam salvas no banco (não mais no localStorage) pra serem as
// mesmas pra todos os atendentes — antes, uma etiqueta criada num navegador
// simplesmente não existia pros outros, e o badge sumia silenciosamente
// (getTagBadgeHTML não encontrava o id e retornava vazio).
let cachedAvailableTags = null;

async function loadAvailableTags() {
    try {
        const res = await fetch('/api/settings/whatsapp-tags');
        const json = await res.json();
        cachedAvailableTags = (Array.isArray(json.tags) && json.tags.length > 0) ? json.tags : DEFAULT_TAGS;
    } catch (e) {
        cachedAvailableTags = DEFAULT_TAGS;
    }
    return cachedAvailableTags;
}

function getAvailableTags() {
    return cachedAvailableTags || DEFAULT_TAGS;
}

async function saveAvailableTags(tags) {
    cachedAvailableTags = tags; // otimista: UI atualiza na hora, sem esperar o servidor
    try {
        await fetch('/api/settings/whatsapp-tags', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tags })
        });
    } catch (e) {
        console.error('Erro ao salvar etiquetas no servidor:', e);
    }
}

function parseLeadTags(rawTags) {
    if (!rawTags) return [];
    if (Array.isArray(rawTags)) return rawTags;
    if (typeof rawTags === 'string') {
        return rawTags.split(',').map(t => t.trim()).filter(Boolean);
    }
    return [];
}

function getTagBadgeHTML(tagId) {
    const tags = getAvailableTags();
    const found = tags.find(t => t.id === tagId);
    if (!found) return '';
    return `<span style="position: relative; font-size: 0.72rem; font-weight: 600; line-height: 1.5; padding: 0.22rem 0.6rem 0.22rem 1.15rem; background: ${found.color}; color: #0a0a0a; clip-path: polygon(14px 0, calc(100% - 3px) 0, 100% 3px, 100% calc(100% - 3px), calc(100% - 3px) 100%, 14px 100%, 0 50%); display: inline-flex; align-items: center;">
        <span style="position: absolute; left: 7px; top: 50%; transform: translateY(-50%); width: 4px; height: 4px; border-radius: 50%; background: rgba(0,0,0,0.55);"></span>
        ${found.label}
    </span>`;
}

function renderChatTagsUI(lead) {
    const container = document.getElementById('chat-active-tags-list');
    if (!container) return;

    const leadTags = parseLeadTags(lead ? lead.tags : '');
    if (leadTags.length === 0) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = leadTags.map(tagId => getTagBadgeHTML(tagId)).join('');
}

function formatPhoneDisplay(phone) {
    if (!phone) return '-';
    let digits = String(phone).replace(/\D/g, '');
    let ddi = '';
    if (digits.length > 11 && digits.startsWith('55')) {
        ddi = '+55 ';
        digits = digits.substring(2);
    }
    if (digits.length === 11) return `${ddi}(${digits.substring(0,2)}) ${digits.substring(2,7)}-${digits.substring(7,11)}`;
    if (digits.length === 10) return `${ddi}(${digits.substring(0,2)}) ${digits.substring(2,6)}-${digits.substring(6,10)}`;
    return ddi + digits;
}

function splitAdBlockFromNotes(notas) {
    if (!notas) return { adBlock: '', rest: '' };
    const idx = notas.indexOf('[Lead de Anúncio Meta]');
    if (idx === -1) return { adBlock: '', rest: notas };
    const afterIdx = notas.indexOf('\n\n', idx);
    if (afterIdx === -1) return { adBlock: notas.substring(idx).trim(), rest: notas.substring(0, idx).trim() };
    const adBlock = notas.substring(idx, afterIdx).trim();
    const rest = (notas.substring(0, idx) + notas.substring(afterIdx + 2)).trim();
    return { adBlock, rest };
}

async function saveLeadNotesFromChat(leadId) {
    const textarea = document.getElementById('chat-lead-notes-textarea');
    const btn = document.getElementById('chat-lead-notes-save-btn');
    if (!textarea || typeof leads === 'undefined') return;

    const lead = leads.find(l => l.id === leadId);
    if (!lead) return;

    const { adBlock } = splitAdBlockFromNotes(lead.notas);
    const newRest = textarea.value.trim();
    lead.notas = adBlock ? `${adBlock}\n\n${newRest}` : newRest;

    const oldLabel = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="amicro-loader"><span></span><span></span><span></span></span> Salvando...'; }

    try {
        await fetch(`/api/leads/${leadId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notas: lead.notas })
        });
        leadPanelNotesDirty = false;

        // Atualiza o resumo no card recolhido e fecha o bloco de notas
        const badgePreview = document.querySelector('#lead-notes-badge span');
        if (badgePreview) {
            const hasNotes = !!newRest;
            badgePreview.textContent = hasNotes
                ? newRest.split('\n')[0].slice(0, 40) + (newRest.length > 40 ? '…' : '')
                : 'Clique para anotar';
            badgePreview.style.color = hasNotes ? 'var(--text-main)' : 'var(--nav-arrow)';
        }
        toggleLeadNotesExpanded();
    } catch (e) {
        console.error('Erro ao salvar notas do lead', e);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = oldLabel; }
    }
}

async function toggleLeadCampaignOptOut(leadId, currentlyOptedOut) {
    const newValue = !currentlyOptedOut;
    try {
        await fetch(`/api/leads/${leadId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ campaign_opt_out: newValue })
        });
        if (typeof leads !== 'undefined') {
            const lead = leads.find(l => l.id === leadId);
            if (lead) lead.campaign_opt_out = newValue ? 1 : 0;
        }
        if (typeof showToast === 'function') {
            showToast(newValue ? 'Lead não vai mais receber campanhas.' : 'Lead voltou a receber campanhas.', 'success');
        }
        if (window.currentActiveChat && typeof leads !== 'undefined') {
            const currentLead = leads.find(l => l.id === leadId);
            renderLeadInfoPanel(currentLead, window.currentActiveChat.phone);
        }
    } catch (e) {
        console.error('Erro ao atualizar opt-out de campanha:', e);
        if (typeof showToast === 'function') showToast('Não foi possível salvar essa preferência.', 'danger'); else alert('Não foi possível salvar essa preferência.');
    }
}

function toggleLeadNotesExpanded() {
    const badge = document.getElementById('lead-notes-badge');
    const expanded = document.getElementById('lead-notes-expanded');
    if (!badge || !expanded) return;

    const isOpening = expanded.style.display !== 'block';
    expanded.style.display = isOpening ? 'block' : 'none';
    badge.style.display = isOpening ? 'none' : 'flex';

    if (isOpening) {
        const textarea = document.getElementById('chat-lead-notes-textarea');
        if (textarea) textarea.focus();
    } else {
        leadPanelNotesDirty = false;
    }
}

// Evita que o polling (a cada 5s) reescreva o painel do lead enquanto o
// atendente está digitando nas Notas Internas — sem isso, o texto digitado
// some no meio da digitação assim que uma atualização silenciosa chega.
let leadPanelNotesDirty = false;

function renderLeadInfoPanel(lead, phone, lastInteraction) {
    const container = document.getElementById('chat-lead-info-content');
    if (!container) return;

    const existingTextarea = document.getElementById('chat-lead-notes-textarea');
    const isEditingNotes = existingTextarea && (document.activeElement === existingTextarea || leadPanelNotesDirty);
    const transferPopup = document.getElementById('transfer-menu-popup');
    const isTransferMenuOpen = transferPopup && transferPopup.style.display === 'block';
    const isSameChatRerender = container.dataset.renderedPhone === String(phone);
    if ((isEditingNotes || isTransferMenuOpen) && isSameChatRerender) {
        return; // mesma conversa, com edição/menu em andamento — não sobrescreve
    }
    container.dataset.renderedPhone = String(phone);
    leadPanelNotesDirty = false;

    const aiToggle = document.getElementById('chat-ai-toggle');
    const aiToggleLabel = document.getElementById('chat-ai-toggle-label');
    if (aiToggle) {
        const aiEnabled = lead ? Number(lead.ai_enabled) !== 0 : false;
        aiToggle.checked = aiEnabled;
        aiToggle.disabled = !lead;
        if (aiToggleLabel) {
            aiToggleLabel.textContent = !lead
                ? 'IA respondendo esta conversa (sem lead vinculado)'
                : 'IA respondendo esta conversa';
        }
    }

    const identityContainer = document.getElementById('chat-lead-identity');
    if (identityContainer) {
        const leadName = (lead && lead.nome) || (window.currentActiveChat && window.currentActiveChat.name) || 'Contato';
        const identityLastTs = lastInteraction ? lastInteraction.ts : null;
        const identityLastDir = lastInteraction ? lastInteraction.dir : null;
        const identityOnlineInfo = getLeadOnlineStatus(identityLastTs, identityLastDir);
        const identityAvatarHTML = typeof renderAvatarHTML === 'function'
            ? renderAvatarHTML(leadName, null, identityOnlineInfo.statusClass, 44)
            : '';
        identityContainer.innerHTML = `
            ${identityAvatarHTML}
            <div style="min-width: 0;">
                <div style="font-size: 0.95rem; font-weight: 700; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(leadName)}</div>
                <div style="font-size: 0.75rem; color: var(--nav-arrow);">${escapeHtml(identityOnlineInfo.text || '')}</div>
            </div>
        `;
    }

    let responsavelHTML = '';
    if (lead && lead.owner_id) {
        const ownerName = typeof resolveDisplayName === 'function' ? resolveDisplayName(lead.owner_id) : lead.owner_id;
        const ownerAvatarUrl = (typeof avatarMap !== 'undefined' && avatarMap[lead.owner_id]) || null;
        const ownerAvatarHTML = typeof renderAvatarHTML === 'function' ? renderAvatarHTML(ownerName, ownerAvatarUrl, null, 24) : '';
        const currentUserForPanel = (typeof loggedUser !== 'undefined' && loggedUser) ? loggedUser.username : null;
        const isMineToTransfer = currentUserForPanel && lead.owner_id === currentUserForPanel;

        const transferHTML = isMineToTransfer ? `
            <div style="position: relative;">
                <button class="lead-panel-btn" style="width: auto; height: 27px; padding: 0 0.55rem; font-size: 0.76rem; gap: 0.35rem;" onclick="toggleTransferMenu(event, '${lead.id}')" title="Passar essa conversa pra outro atendente">
                    <i class="fa-solid fa-right-left" style="font-size: 0.72rem;"></i> Transferir
                </button>
                <div id="transfer-menu-popup" style="display: none; position: absolute; right: 0; top: calc(100% + 6px); width: 230px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 10px; box-shadow: none; z-index: 1000; max-height: 260px; overflow-y: auto; padding: 0.4rem 0;">
                    <div style="padding: 0.6rem 0.9rem; color: var(--text-muted); font-size: 0.78rem;">Carregando equipe...</div>
                </div>
            </div>
        ` : '';

        responsavelHTML = `
            <div>
                <div class="lead-panel-label"><i class="fa-solid fa-user-check"></i> Responsável</div>
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;">
                    <div style="display: flex; align-items: center; gap: 0.5rem; min-width: 0;">
                        ${ownerAvatarHTML}
                        <span style="font-size: 0.85rem; color: var(--text-main); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(ownerName)}</span>
                    </div>
                    ${transferHTML}
                </div>
            </div>
        `;
    }

    let tempoHTML = '';
    if (lead && lead.created_at && typeof parseSqlDate === 'function') {
        const createdDate = parseSqlDate(lead.created_at);
        let idadeTexto = '-';
        if (createdDate) {
            const diffDays = Math.ceil(Math.abs(new Date() - createdDate) / (1000 * 60 * 60 * 24));
            idadeTexto = diffDays <= 0 ? 'Hoje' : `${diffDays}d atrás`;
        }

        // Preferir o histórico real da conversa (lastInteraction, vindo das mensagens já carregadas)
        // em vez da allChatsList, que é populada por polling e pode estar desatualizada/sem esse número ainda.
        let lastTs = lastInteraction ? lastInteraction.ts : null;
        let lastDir = lastInteraction ? lastInteraction.dir : null;
        if (!lastTs) {
            const targetChat = (typeof allChatsList !== 'undefined' && Array.isArray(allChatsList))
                ? allChatsList.find(c => isSamePhone(c.phone, phone))
                : null;
            lastTs = targetChat ? (targetChat.last_timestamp || targetChat.timestamp) : null;
            lastDir = targetChat ? (targetChat.last_direction || targetChat.direction) : null;
        }
        const lastInteracaoTexto = lastTs ? getLeadOnlineStatus(lastTs, lastDir).text : 'Sem mensagens ainda';

        tempoHTML = `
            <div>
                <div class="lead-panel-label"><i class="fa-regular fa-clock"></i> Tempo como Lead</div>
                <div style="font-size: 0.82rem; color: var(--text-main);">Lead há <strong>${idadeTexto}</strong></div>
                <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.15rem;">Última interação: ${escapeHtml(lastInteracaoTexto)}</div>
            </div>
        `;
    }

    const telefoneHTML = `
        <div>
            <div class="lead-panel-label"><i class="fa-solid fa-phone"></i> Telefone</div>
            <div style="font-size: 0.85rem; color: var(--text-main); font-weight: 500;">${escapeHtml(formatPhoneDisplay((lead && lead.telefone) || phone))}</div>
        </div>
    `;

    const origem = lead && lead.origem ? lead.origem : 'Não identificada';
    const isMetaAd = origem && (origem.includes('Meta Ads') || origem.includes('Anúncio'));
    const origemHTML = `
        <div>
            <div class="lead-panel-label"><i class="fa-solid fa-bullhorn"></i> Origem</div>
            <div class="lead-panel-chip">
                <i class="${isMetaAd ? 'fa-brands fa-facebook' : 'fa-solid fa-circle-nodes'}" style="color: ${isMetaAd ? '#60a5fa' : 'var(--nav-arrow)'};"></i> ${escapeHtml(origem)}
            </div>
        </div>
    `;

    // Extrai os dados do anúncio salvos nas notas do lead pelo webhook do WhatsApp
    let anuncioHTML = `
        <div class="lead-panel-empty">
            <i class="fa-regular fa-circle-xmark"></i> Não veio de um anúncio (contato orgânico)
        </div>
    `;
    const notas = lead && lead.notas ? lead.notas : '';
    const adMatch = notas.match(/\[Lead de Anúncio Meta\][\s\S]*?T[ií]tulo do An[uú]ncio:\s*([^\n]*)[\s\S]*?Descri[cç][ãa]o:\s*([^\n]*)[\s\S]*?Link:\s*([^\n]*)/i);
    if (adMatch) {
        const [, headline, descricao, link] = adMatch;
        anuncioHTML = `
            <div class="lead-panel-card" style="display: flex; flex-direction: column; gap: 0.3rem;">
                <div style="font-size: 0.7rem; font-weight: 700; color: #60a5fa; text-transform: uppercase; letter-spacing: 0.04em; display: flex; align-items: center; gap: 0.3rem;"><i class="fa-brands fa-facebook"></i> Veio de Anúncio</div>
                ${headline ? `<div style="font-size: 0.82rem; font-weight: 600; color: var(--text-main);">${escapeHtml(headline.trim())}</div>` : ''}
                ${descricao ? `<div style="font-size: 0.78rem; color: var(--text-muted); line-height: 1.35;">${escapeHtml(descricao.trim())}</div>` : ''}
                ${link && link.trim() ? `<a href="${escapeHtml(link.trim())}" target="_blank" rel="noopener" style="font-size: 0.75rem; color: #60a5fa; word-break: break-all; margin-top: 0.1rem;">${escapeHtml(link.trim())}</a>` : ''}
            </div>
        `;
    }

    const anuncioBlockHTML = `
        <div>
            <div class="lead-panel-label"><i class="fa-solid fa-rectangle-ad"></i> Anúncio</div>
            ${anuncioHTML}
        </div>
    `;

    const fbClickId = lead && lead.fb_click_id ? lead.fb_click_id : '';
    const rastreamentoHTML = `
        <div>
            <div class="lead-panel-label"><i class="fa-solid fa-satellite-dish"></i> Rastreamento</div>
            ${fbClickId
                ? `<div class="lead-panel-card" style="font-size: 0.75rem; color: var(--text-main); word-break: break-all;"><span style="color: var(--text-muted);">FB Click ID:</span><br>${escapeHtml(fbClickId)}</div>`
                : `<div class="lead-panel-empty"><i class="fa-regular fa-circle-xmark"></i> Sem dados de rastreamento</div>`
            }
        </div>
    `;

    let valorHTML = '';
    if (lead && (lead.valor_recebido || lead.orcamento)) {
        let orc = {};
        try { orc = lead.orcamento ? (typeof lead.orcamento === 'string' ? JSON.parse(lead.orcamento) : lead.orcamento) : {}; } catch (e) {}

        const valorRecebido = lead.valor_recebido ? `R$ ${parseFloat(lead.valor_recebido).toFixed(2).replace('.', ',')}` : '';
        const valorOrcado = orc.valor ? `R$ ${parseFloat(orc.valor).toFixed(2).replace('.', ',')}` : '';

        // Só renderiza a seção se houver de fato algum valor — um orcamento "{}"
        // vazio é truthy e antes gerava um card sem nenhuma linha dentro.
        if (valorRecebido || valorOrcado) {
            valorHTML = `
                <div>
                    <div class="lead-panel-label"><i class="fa-solid fa-sack-dollar"></i> Valor</div>
                    <div class="lead-panel-card${valorRecebido ? ' lead-panel-card--money' : ''}" style="display: flex; flex-direction: column; gap: 0.35rem;">
                        ${valorRecebido ? `<div style="display: flex; justify-content: space-between; font-size: 0.82rem;"><span style="color: var(--text-muted);">Recebido</span><span style="color: var(--accent-success); font-weight: 700;">${valorRecebido}</span></div>` : ''}
                        ${valorOrcado ? `<div style="display: flex; justify-content: space-between; font-size: 0.82rem;"><span style="color: var(--text-muted);">Orçado${orc.procedimento ? ` (${escapeHtml(orc.procedimento)})` : ''}</span><span style="color: var(--text-main); font-weight: 600;">${valorOrcado}</span></div>` : ''}
                    </div>
                </div>
            `;
        }
    }

    let notasHTML = '';
    if (lead) {
        const { rest: notasRest } = splitAdBlockFromNotes(lead.notas);
        const hasNotes = !!notasRest.trim();
        const previewText = hasNotes
            ? escapeHtml(notasRest.trim().split('\n')[0].slice(0, 40)) + (notasRest.trim().length > 40 ? '…' : '')
            : 'Clique para anotar';
        const prevExpandedEl = document.getElementById('lead-notes-expanded');
        const wasExpanded = isSameChatRerender && prevExpandedEl && prevExpandedEl.style.display === 'block';

        notasHTML = `
            <div>
                <div class="lead-panel-label"><i class="fa-regular fa-note-sticky"></i> Notas Internas</div>
                <div id="lead-notes-badge" class="lead-panel-card" onclick="toggleLeadNotesExpanded()"
                    style="cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 8px; ${wasExpanded ? 'display: none;' : ''}">
                    <span style="font-size: 12.5px; color: ${hasNotes ? 'var(--text-main)' : 'var(--nav-arrow)'}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${previewText}</span>
                    <i class="fa-solid fa-chevron-down" style="font-size: 11px; color: var(--nav-arrow); flex-shrink: 0;"></i>
                </div>
                <div id="lead-notes-expanded" style="display: ${wasExpanded ? 'block' : 'none'};">
                    <textarea id="chat-lead-notes-textarea" rows="4" placeholder="Anotações sobre este lead..."
                        oninput="leadPanelNotesDirty = true" class="lead-panel-textarea">${escapeHtml(notasRest)}</textarea>
                    <div style="display: flex; gap: 6px; margin-top: 0.5rem;">
                        <button id="chat-lead-notes-save-btn" class="lead-panel-btn" onclick="saveLeadNotesFromChat('${lead.id}')">
                            <i class="fa-solid fa-floppy-disk"></i> Salvar Notas
                        </button>
                        <button type="button" class="lead-panel-btn" style="width: 34px; flex: none;" title="Recolher" onclick="toggleLeadNotesExpanded()">
                            <i class="fa-solid fa-chevron-up"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    let optOutHTML = '';
    if (lead) {
        const isOptedOut = Number(lead.campaign_opt_out) === 1;
        const state = isOptedOut ? 'off' : 'on';
        const statusText = isOptedOut ? 'Fora das campanhas' : 'Recebe campanhas';
        const actionText = isOptedOut ? 'Reativar' : 'Excluir';
        optOutHTML = `
            <div>
                <div class="lead-panel-label"><i class="fa-solid fa-shield-halved"></i> Campanhas de Marketing</div>
                <button type="button" class="lp-campaign-btn" data-state="${state}"
                    title="${isOptedOut ? 'Voltar a incluir este lead nas campanhas' : 'Remover este lead das campanhas de marketing'}"
                    onclick="toggleLeadCampaignOptOut('${lead.id}', ${isOptedOut})">
                    <span class="lp-campaign-status"><span class="lp-campaign-dot"></span> ${statusText}</span>
                    <span class="lp-campaign-action">${actionText} <i class="fa-solid fa-chevron-right"></i></span>
                </button>
            </div>
        `;
    }

    const newPanelHTML = responsavelHTML + tempoHTML + telefoneHTML + origemHTML + anuncioBlockHTML + rastreamentoHTML + valorHTML + notasHTML + optOutHTML;

    // Só reescreve o DOM se o conteúdo realmente mudou — o polling chama isso a
    // cada poucos segundos, e reescrever sempre (mesmo com o texto idêntico)
    // fazia a tela toda "piscar" (reflow/repaint) sem necessidade nenhuma.
    if (container.dataset.lastRenderedHtml !== newPanelHTML) {
        container.dataset.lastRenderedHtml = newPanelHTML;
        container.innerHTML = newPanelHTML;
    }
}

// ============================================
// TRANSFERÊNCIA DELIBERADA DE CONVERSA (quem está com a conversa escolhe passar pra outro atendente)
// ============================================
let cachedTeamUsers = null;

async function toggleTransferMenu(e, leadId) {
    if (e) e.stopPropagation();
    const popup = document.getElementById('transfer-menu-popup');
    if (!popup) return;

    const isShowing = popup.style.display === 'block';
    popup.style.display = isShowing ? 'none' : 'block';
    if (isShowing) return;

    popup.innerHTML = `<div style="padding: 0.6rem 0.9rem; color: var(--text-muted); font-size: 0.78rem;"><span class="amicro-loader"><span></span><span></span><span></span></span> Carregando equipe...</div>`;

    try {
        if (!cachedTeamUsers) {
            const res = await fetch('/api/users');
            cachedTeamUsers = await res.json();
        }
        const currentUser = (typeof loggedUser !== 'undefined' && loggedUser) ? loggedUser.username : null;
        const others = (cachedTeamUsers || []).filter(u => u.username !== currentUser);

        if (others.length === 0) {
            popup.innerHTML = `<div style="padding: 0.6rem 0.9rem; color: var(--text-muted); font-size: 0.78rem;">Não há outro atendente cadastrado.</div>`;
            return;
        }

        popup.innerHTML = others.map(u => {
            const name = typeof resolveDisplayName === 'function' ? resolveDisplayName(u.username) : u.username;
            const avatarUrl = (typeof avatarMap !== 'undefined' && avatarMap[u.username]) || null;
            const avatarHTML = typeof renderAvatarHTML === 'function' ? renderAvatarHTML(name, avatarUrl, null, 24) : '';
            return `
                <div onclick="transferLeadTo('${leadId}', '${u.username}')"
                    style="padding: 0.55rem 0.9rem; cursor: pointer; display: flex; align-items: center; gap: 0.6rem; font-size: 0.85rem; color: var(--text-main); font-weight: 500; transition: 0.15s;"
                    onmouseover="this.style.background='rgba(255,255,255,0.08)'"
                    onmouseout="this.style.background='transparent'">
                    ${avatarHTML}
                    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(name)}</span>
                </div>
            `;
        }).join('');
    } catch (err) {
        console.error('Erro ao carregar equipe para transferência:', err);
        popup.innerHTML = `<div style="padding: 0.6rem 0.9rem; color: var(--accent-danger, #f87171); font-size: 0.78rem;">Erro ao carregar a equipe.</div>`;
    }
}

async function transferLeadTo(leadId, toUsername) {
    const popup = document.getElementById('transfer-menu-popup');
    if (popup) popup.style.display = 'none';

    try {
        const res = await fetch(`/api/leads/${leadId}/transfer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: toUsername })
        });
        const json = await res.json().catch(() => ({}));

        if (!res.ok || !json.success) {
            alert(json.error || 'Não foi possível transferir a conversa.');
            return;
        }

        // A conversa deixou de ser nossa: para a renovação automática e passa pro estado
        // "travada por outro atendente" (o próprio atendente que acabou de receber).
        stopLeadLockRenewal();
        const ownerName = getLockOwnerDisplayName(toUsername);
        window.chatLockState = { leadId, locked: true, ownerId: toUsername };
        applyChatLockUI(true, ownerName);

        if (typeof leads !== 'undefined') {
            const lead = leads.find(l => l.id === leadId);
            if (lead) {
                lead.owner_id = toUsername;
                if (typeof renderBoard === 'function') renderBoard();
            }
        }
        if (window.currentActiveChat) {
            renderLeadInfoPanel(leads.find(l => l.id === leadId), window.currentActiveChat.phone);
        }
    } catch (err) {
        console.error('Erro ao transferir conversa:', err);
        alert('Erro de conexão ao transferir a conversa.');
    }
}

function toggleTagsMenu(e) {
    if (e) e.stopPropagation();
    const popup = document.getElementById('tags-menu-popup');
    if (!popup) return;
    const isShowing = popup.style.display === 'block';
    popup.style.display = isShowing ? 'none' : 'block';

    if (!isShowing) {
        switchToSelectTagsView();
    }
}

function switchToManageTagsView(e) {
    if (e) e.stopPropagation();
    const vSelect = document.getElementById('tags-view-select');
    const vManage = document.getElementById('tags-view-manage');
    if (vSelect) vSelect.style.display = 'none';
    if (vManage) vManage.style.display = 'block';
    cancelEditCustomTag();
    renderManageTagsList();
}

function switchToSelectTagsView(e) {
    if (e) e.stopPropagation();
    const vSelect = document.getElementById('tags-view-select');
    const vManage = document.getElementById('tags-view-manage');
    if (vSelect) vSelect.style.display = 'block';
    if (vManage) vManage.style.display = 'none';
    cancelEditCustomTag();
    renderTagsMenuOptions();
}

function renderTagsMenuOptions() {
    const container = document.getElementById('tags-options-container');
    if (!container) return;

    let currentLeadTags = [];
    if (window.currentActiveChat && typeof leads !== 'undefined') {
        const phone = window.currentActiveChat.phone;
        const currentLead = leads.find(l => isSamePhone(l.telefone, phone));
        if (currentLead) {
            currentLeadTags = parseLeadTags(currentLead.tags);
        }
    }

    const availableTags = getAvailableTags();
    let html = '';
    availableTags.forEach(tag => {
        const isChecked = currentLeadTags.includes(tag.id);
        html += `
            <div onclick="toggleLeadTag('${tag.id}')" style="padding: 0.5rem 0.7rem; border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: space-between; background: ${isChecked ? tag.bg : 'rgba(255,255,255,0.03)'}; border: 1px solid ${isChecked ? tag.border : 'var(--border-color)'}; transition: 0.15s;" onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'">
                <span style="font-size: 0.82rem; font-weight: 500; color: ${tag.color};">${tag.label}</span>
                <i class="fa-solid ${isChecked ? 'fa-square-check' : 'fa-square'}" style="color: ${isChecked ? tag.color : 'var(--text-muted)'}; font-size: 0.95rem;"></i>
            </div>
        `;
    });
    container.innerHTML = html;
}

// Etiquetas que o próprio sistema depende pra funcionar — apagar quebraria um
// recurso automático em vez de só remover uma etiqueta comum: "aguardando" é
// usada pelo cálculo automático de "5 minutos sem resposta", e
// "ia-qualificado" é usada pelo agente de IA pra marcar lead qualificado.
const PROTECTED_TAG_IDS = ['aguardando', 'ia-qualificado'];
let editingTagId = null;

function renderManageTagsList() {
    const container = document.getElementById('manage-tags-list');
    if (!container) return;

    const tags = getAvailableTags();
    if (tags.length === 0) {
        container.innerHTML = '<div style="font-size: 0.85rem; color: var(--text-muted); text-align: center; padding: 1rem;">Nenhuma etiqueta cadastrada.</div>';
        return;
    }

    let html = '';
    tags.forEach(tag => {
        const isProtected = PROTECTED_TAG_IDS.includes(tag.id);
        const deleteBtnHTML = isProtected
            ? `<i class="fa-solid fa-lock" style="color: var(--text-muted); padding: 0.1rem 0.3rem; font-size: 0.8rem;" title="Etiqueta usada pelo sistema — não pode ser excluída"></i>`
            : `<button onclick="deleteCustomTag('${tag.id}')" style="background: none; border: none; color: var(--accent-danger); cursor: pointer; padding: 0.1rem 0.3rem; font-size: 0.85rem;" title="Excluir etiqueta"><i class="fa-solid fa-trash"></i></button>`;
        html += `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 0.45rem 0.6rem; background: var(--bg-main); border-radius: 6px; border: 1px solid var(--border-color);">
                <div style="display: flex; align-items: center; gap: 0.4rem;">
                    <span style="font-size: 0.75rem; font-weight: 600; padding: 0.15rem 0.4rem; border-radius: 10px; background: ${tag.bg}; color: ${tag.color}; border: 1px solid ${tag.border};">${tag.label}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 0.2rem;">
                    <button onclick='startEditCustomTag(${JSON.stringify(tag.id)})' style="background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 0.1rem 0.3rem; font-size: 0.85rem;" title="Editar nome/cor"><i class="fa-solid fa-pen"></i></button>
                    ${deleteBtnHTML}
                </div>
            </div>
        `;
    });
    container.innerHTML = html;
}

function hexToRgba(hex, alpha = 0.15) {
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    const num = parseInt(c, 16);
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function startEditCustomTag(tagId) {
    const tag = getAvailableTags().find(t => t.id === tagId);
    if (!tag) return;
    editingTagId = tagId;
    const nameInput = document.getElementById('new-tag-name');
    const colorInput = document.getElementById('new-tag-color');
    const colorIcon = document.getElementById('tag-color-icon');
    if (nameInput) nameInput.value = tag.label;
    if (colorInput) colorInput.value = tag.color;
    if (colorIcon) colorIcon.style.color = tag.color;

    const saveBtn = document.getElementById('tag-save-btn');
    if (saveBtn) saveBtn.innerHTML = '<i class="fa-solid fa-check"></i> Salvar Alteração';
    const cancelBtn = document.getElementById('tag-edit-cancel-btn');
    if (cancelBtn) cancelBtn.style.display = 'inline-flex';
}

function cancelEditCustomTag() {
    editingTagId = null;
    const nameInput = document.getElementById('new-tag-name');
    const colorInput = document.getElementById('new-tag-color');
    const colorIcon = document.getElementById('tag-color-icon');
    if (nameInput) nameInput.value = '';
    if (colorInput) colorInput.value = '#3b82f6';
    if (colorIcon) colorIcon.style.color = '#3b82f6';

    const saveBtn = document.getElementById('tag-save-btn');
    if (saveBtn) saveBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Salvar';
    const cancelBtn = document.getElementById('tag-edit-cancel-btn');
    if (cancelBtn) cancelBtn.style.display = 'none';
}

function saveCustomTag() {
    const nameInput = document.getElementById('new-tag-name');
    const colorInput = document.getElementById('new-tag-color');

    const name = nameInput ? nameInput.value.trim() : '';
    const hexColor = colorInput ? colorInput.value : '#3b82f6';

    if (!name) {
        alert('Por favor, informe o nome da etiqueta.');
        return;
    }

    const bg = hexToRgba(hexColor, 0.15);
    const border = hexColor;
    const currentTags = getAvailableTags();

    if (editingTagId) {
        // Atualiza nome/cor no lugar — mantém o mesmo id, então os leads que já
        // têm essa etiqueta atribuída continuam mostrando ela normalmente.
        const idx = currentTags.findIndex(t => t.id === editingTagId);
        if (idx !== -1) {
            currentTags[idx] = { ...currentTags[idx], label: name, bg, color: hexColor, border };
        }
        saveAvailableTags(currentTags);
        cancelEditCustomTag();
    } else {
        const newTag = { id: 'custom_' + Date.now(), label: name, bg, color: hexColor, border };
        currentTags.push(newTag);
        saveAvailableTags(currentTags);
        if (nameInput) nameInput.value = '';
    }

    renderManageTagsList();
    if (typeof renderBoard === 'function') renderBoard();
    if (window.currentActiveChat && typeof leads !== 'undefined') {
        const phone = window.currentActiveChat.phone;
        const currentLead = leads.find(l => l.telefone === phone || (l.telefone && l.telefone.includes(phone)));
        renderChatTagsUI(currentLead);
    }
}

async function deleteCustomTag(tagId) {
    if (PROTECTED_TAG_IDS.includes(tagId)) {
        await customAlert('Essa etiqueta é usada pelo sistema (resposta automática ou agente de IA) e não pode ser excluída — mas o nome e a cor podem ser editados livremente.', 'Etiqueta Protegida');
        return;
    }
    if (!await customConfirm('Deseja realmente excluir esta etiqueta?', 'Excluir Etiqueta')) return;
    let tags = getAvailableTags();
    tags = tags.filter(t => t.id !== tagId);
    saveAvailableTags(tags);
    renderManageTagsList();
    if (typeof renderBoard === 'function') renderBoard();
}

async function toggleLeadTag(tagId) {
    if (!window.currentActiveChat || typeof leads === 'undefined') return;
    const phone = window.currentActiveChat.phone;
    let currentLead = leads.find(l => isSamePhone(l.telefone, phone));

    if (!currentLead) return;

    let leadTags = parseLeadTags(currentLead.tags);
    if (leadTags.includes(tagId)) {
        leadTags = leadTags.filter(t => t !== tagId);
    } else {
        leadTags.push(tagId);
    }

    const newTagsStr = leadTags.join(',');
    currentLead.tags = newTagsStr;

    renderChatTagsUI(currentLead);
    renderTagsMenuOptions();
    if (typeof renderBoard === 'function') renderBoard();

    try {
        await fetch(`/api/leads/${currentLead.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tags: newTagsStr })
        });
    } catch(e) {
        console.error("Erro ao salvar etiquetas do lead:", e);
    }
}

// Fechar os menus popup ao clicar em qualquer lugar fora deles
document.addEventListener('click', (e) => {
    const popupStage = document.getElementById('stage-menu-popup');
    const btnStage = document.getElementById('btn-change-stage');
    if (popupStage && btnStage && !popupStage.contains(e.target) && !btnStage.contains(e.target)) {
        popupStage.style.display = 'none';
    }

    const popupTags = document.getElementById('tags-menu-popup');
    const btnTags = document.getElementById('btn-change-tags');
    if (popupTags && btnTags && !popupTags.contains(e.target) && !btnTags.contains(e.target)) {
        popupTags.style.display = 'none';
    }

    const popupAttach = document.getElementById('attach-menu-popup');
    const btnAttach = document.getElementById('btn-chat-attach');
    if (popupAttach && btnAttach && !popupAttach.contains(e.target) && !btnAttach.contains(e.target)) {
        popupAttach.style.display = 'none';
    }

    const popupTransfer = document.getElementById('transfer-menu-popup');
    if (popupTransfer && popupTransfer.style.display !== 'none' && !popupTransfer.contains(e.target) && !e.target.closest('[onclick^="toggleTransferMenu"]')) {
        popupTransfer.style.display = 'none';
    }
});

// === AUTO EXPAND TEXTAREA & KEYDOWN HANDLER ===
function autoExpandChatInput(el) {
    if (!el) return;
    el.style.height = 'auto';
    const newH = Math.min(el.scrollHeight, 140);
    el.style.height = Math.max(newH, 44) + 'px';
}

function handleChatInputKeyDown(event) {
    // Enquanto o popup de respostas rápidas estiver aberto, quem decide o que fazer com
    // Enter/Tab/Escape/setas é o handleQuickReplyKeydown (escolher o item selecionado) —
    // sem esse guard, essa função rodava primeiro e mandava o "/atalho" cru como mensagem
    // antes da resposta rápida ser expandida no campo de texto.
    const qrPopup = document.getElementById('quick-replies-popup');
    const qrPopupOpen = qrPopup && qrPopup.style.display !== 'none';
    if (qrPopupOpen && ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendActiveChatMessage();
    }
}

// === CHAT FILE ATTACHMENTS LOGIC ===
function toggleAttachMenu(e) {
    if (e) e.stopPropagation();
    const popup = document.getElementById('attach-menu-popup');
    if (!popup) return;
    popup.style.display = (popup.style.display === 'block') ? 'none' : 'block';
}

function triggerImageUpload() {
    const popup = document.getElementById('attach-menu-popup');
    if (popup) popup.style.display = 'none';
    const fileInput = document.getElementById('attach-image-input');
    if (fileInput) fileInput.click();
}

function triggerDocUpload() {
    const popup = document.getElementById('attach-menu-popup');
    if (popup) popup.style.display = 'none';
    const fileInput = document.getElementById('attach-doc-input');
    if (fileInput) fileInput.click();
}

let pendingImageFile = null;

// ==========================================
// GRAVAÇÃO DE ÁUDIO (MENSAGEM DE VOZ)
// ==========================================
let voiceRecorder = null;
let voiceRecorderChunks = [];
let voiceRecorderStream = null;
let voiceRecordingStartedAt = null;
let voiceRecordingTimerInterval = null;
let voiceRecordingCancelled = false;

function formatRecordingTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
    const ss = String(totalSeconds % 60).padStart(2, '0');
    return `${mm}:${ss}`;
}

async function toggleVoiceRecording() {
    if (voiceRecorder && voiceRecorder.state === 'recording') {
        stopVoiceRecording();
        return;
    }

    if (!window.currentActiveChat) return;
    if (window.chatLockState && window.chatLockState.locked) {
        alert('Esta conversa está em atendimento por outro atendente. Aguarde ela ficar disponível.');
        return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert('Seu navegador não suporta gravação de áudio.');
        return;
    }

    try {
        voiceRecorderStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
        alert('Não foi possível acessar o microfone. Verifique a permissão do navegador.');
        return;
    }

    voiceRecordingCancelled = false;
    voiceRecorderChunks = [];

    const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    const supportedMime = mimeCandidates.find(m => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m));

    try {
        voiceRecorder = supportedMime ? new MediaRecorder(voiceRecorderStream, { mimeType: supportedMime }) : new MediaRecorder(voiceRecorderStream);
    } catch (e) {
        alert('Não foi possível iniciar a gravação neste navegador.');
        voiceRecorderStream.getTracks().forEach(t => t.stop());
        voiceRecorderStream = null;
        return;
    }

    voiceRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) voiceRecorderChunks.push(e.data);
    };

    voiceRecorder.onstop = async () => {
        if (voiceRecorderStream) {
            voiceRecorderStream.getTracks().forEach(t => t.stop());
            voiceRecorderStream = null;
        }
        clearInterval(voiceRecordingTimerInterval);
        voiceRecordingTimerInterval = null;

        if (voiceRecordingCancelled || voiceRecorderChunks.length === 0) {
            voiceRecorderChunks = [];
            return;
        }

        const mimeType = voiceRecorder.mimeType || 'audio/webm';
        const blob = new Blob(voiceRecorderChunks, { type: mimeType });
        voiceRecorderChunks = [];

        const reader = new FileReader();
        reader.onload = () => {
            sendCustomChatMessage(`[FILE:audio.${(mimeType.split('/')[1] || 'webm').split(';')[0]}]\n` + reader.result, 'audio', '', true);
        };
        reader.readAsDataURL(blob);
    };

    voiceRecorder.start();
    voiceRecordingStartedAt = Date.now();

    const micBtn = document.getElementById('btn-chat-mic');
    if (micBtn) {
        micBtn.innerHTML = '<i class="fa-solid fa-stop"></i>';
        micBtn.style.color = 'var(--accent-danger)';
    }

    const textareaWrap = document.getElementById('chat-input-text');
    const recordingBar = document.getElementById('chat-recording-bar');
    if (textareaWrap) textareaWrap.style.display = 'none';
    if (recordingBar) recordingBar.style.display = 'flex';

    const timerEl = document.getElementById('chat-recording-timer');
    voiceRecordingTimerInterval = setInterval(() => {
        if (timerEl) timerEl.textContent = formatRecordingTime(Date.now() - voiceRecordingStartedAt);
    }, 250);
}

function stopVoiceRecording() {
    if (!voiceRecorder || voiceRecorder.state !== 'recording') return;
    voiceRecorder.stop();
    resetVoiceRecordingUI();
}

function cancelVoiceRecording() {
    if (!voiceRecorder || voiceRecorder.state !== 'recording') return;
    voiceRecordingCancelled = true;
    voiceRecorder.stop();
    resetVoiceRecordingUI();
}

function resetVoiceRecordingUI() {
    const micBtn = document.getElementById('btn-chat-mic');
    if (micBtn) {
        micBtn.innerHTML = '<i class="fa-solid fa-microphone"></i>';
        micBtn.style.color = '';
    }
    const textareaWrap = document.getElementById('chat-input-text');
    const recordingBar = document.getElementById('chat-recording-bar');
    if (textareaWrap) textareaWrap.style.display = 'block';
    if (recordingBar) recordingBar.style.display = 'none';
}

// ==========================================
// BIBLIOTECA DE ÁUDIOS (mensagens de voz salvas pra reenvio rápido)
// ==========================================
let cachedVoiceLibrary = [];

async function loadVoiceLibrary() {
    const listEl = document.getElementById('vl-list');
    if (!listEl) return;
    listEl.innerHTML = `<div style="text-align:center; padding: 1.5rem 0; color: var(--text-muted); font-size: 0.85rem;"><span class="amicro-loader"><span></span><span></span><span></span></span> Carregando...</div>`;

    try {
        const res = await fetch('/api/voice-library');
        const json = await res.json();
        cachedVoiceLibrary = json.items || [];
        renderVoiceLibraryList();
    } catch (e) {
        listEl.innerHTML = `<div style="text-align:center; padding: 1.5rem 0; color: var(--accent-danger); font-size: 0.85rem;">Falha ao carregar a biblioteca.</div>`;
    }
}

function renderVoiceLibraryList() {
    const listEl = document.getElementById('vl-list');
    if (!listEl) return;

    if (cachedVoiceLibrary.length === 0) {
        listEl.innerHTML = `<div style="text-align:center; padding: 1.5rem 0; color: var(--text-muted); font-size: 0.85rem;">Nenhum áudio salvo ainda. Grave um acima.</div>`;
        return;
    }

    listEl.innerHTML = cachedVoiceLibrary.map(item => `
        <div style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: 10px; padding: 0.7rem 0.9rem; display: flex; flex-direction: column; gap: 0.5rem;">
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.6rem;">
                <span style="font-weight: 600; font-size: 0.88rem; color: var(--text-main); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(item.nome)}</span>
                <div style="display: flex; gap: 0.4rem; flex-shrink: 0;">
                    <button type="button" onclick="sendFromLibrary('${item.id}', ${escapeHtml(JSON.stringify(item.nome))})" title="Enviar na conversa atual" ${window.currentActiveChat ? '' : 'disabled'}
                        style="background: var(--accent-success); border: none; color: #fff; padding: 0.35rem 0.6rem; border-radius: 6px; cursor: pointer; font-size: 0.78rem; opacity: ${window.currentActiveChat ? '1' : '0.5'};">
                        <i class="fa-solid fa-paper-plane"></i>
                    </button>
                    <button type="button" onclick="deleteLibraryAudio('${item.id}')" title="Excluir"
                        style="background: var(--bg-card); border: 1px solid var(--border-color); color: var(--accent-danger); padding: 0.35rem 0.6rem; border-radius: 6px; cursor: pointer; font-size: 0.78rem;">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
            <audio controls preload="none" src="/api/voice-library/${encodeURIComponent(item.id)}/audio" style="width: 100%; height: 32px;"></audio>
        </div>
    `).join('');
}

async function sendFromLibrary(id, nome) {
    if (!window.currentActiveChat) return;
    try {
        const res = await fetch(`/api/voice-library/${encodeURIComponent(id)}/audio`);
        if (!res.ok) throw new Error('Não foi possível carregar esse áudio.');
        const blob = await res.blob();

        const reader = new FileReader();
        reader.onload = () => {
            closeQuickRepliesModal();
            const popup = document.getElementById('quick-replies-popup');
            if (popup) popup.style.display = 'none';
            sendCustomChatMessage(`[FILE:${nome}.ogg]\n` + reader.result, nome, '', true);
        };
        reader.readAsDataURL(blob);
    } catch (e) {
        alert(e.message);
    }
}

async function deleteLibraryAudio(id) {
    if (!await customConfirm('Excluir este áudio da biblioteca?', 'Excluir Áudio')) return;
    try {
        const res = await fetch(`/api/voice-library/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json()).error || 'Erro ao excluir');
        await loadVoiceLibrary();
    } catch (e) {
        alert(e.message);
    }
}

// --- Gravação dedicada pra salvar na biblioteca (estado separado da gravação do chat) ---
let vlRecorder = null;
let vlRecorderChunks = [];
let vlRecorderStream = null;
let vlRecordingStartedAt = null;
let vlRecordingTimerInterval = null;
let vlRecordingCancelled = false;
let vlPendingBlob = null;
let vlPendingDurationSeconds = null;

async function startLibraryRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert('Seu navegador não suporta gravação de áudio.');
        return;
    }
    try {
        vlRecorderStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
        alert('Não foi possível acessar o microfone. Verifique a permissão do navegador.');
        return;
    }

    vlRecordingCancelled = false;
    vlRecorderChunks = [];

    const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    const supportedMime = mimeCandidates.find(m => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m));

    try {
        vlRecorder = supportedMime ? new MediaRecorder(vlRecorderStream, { mimeType: supportedMime }) : new MediaRecorder(vlRecorderStream);
    } catch (e) {
        alert('Não foi possível iniciar a gravação neste navegador.');
        vlRecorderStream.getTracks().forEach(t => t.stop());
        vlRecorderStream = null;
        return;
    }

    vlRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) vlRecorderChunks.push(e.data);
    };

    vlRecorder.onstop = () => {
        if (vlRecorderStream) {
            vlRecorderStream.getTracks().forEach(t => t.stop());
            vlRecorderStream = null;
        }
        clearInterval(vlRecordingTimerInterval);
        vlRecordingTimerInterval = null;

        document.getElementById('vl-record-active').style.display = 'none';

        if (vlRecordingCancelled || vlRecorderChunks.length === 0) {
            vlRecorderChunks = [];
            document.getElementById('vl-idle-actions').style.display = 'flex';
            return;
        }

        const mimeType = vlRecorder.mimeType || 'audio/webm';
        vlPendingBlob = new Blob(vlRecorderChunks, { type: mimeType });
        vlPendingDurationSeconds = Math.round((Date.now() - vlRecordingStartedAt) / 1000);
        vlRecorderChunks = [];

        const namingEl = document.getElementById('vl-record-naming');
        const nameInput = document.getElementById('vl-record-name-input');
        if (nameInput) { nameInput.value = ''; nameInput.focus(); }
        if (namingEl) namingEl.style.display = 'flex';
    };

    vlRecorder.start();
    vlRecordingStartedAt = Date.now();

    document.getElementById('vl-idle-actions').style.display = 'none';
    document.getElementById('vl-record-active').style.display = 'flex';

    const timerEl = document.getElementById('vl-record-timer');
    vlRecordingTimerInterval = setInterval(() => {
        if (timerEl) timerEl.textContent = formatRecordingTime(Date.now() - vlRecordingStartedAt);
    }, 250);
}

function stopLibraryRecording() {
    if (!vlRecorder || vlRecorder.state !== 'recording') return;
    vlRecorder.stop();
}

function cancelLibraryRecording() {
    if (!vlRecorder || vlRecorder.state !== 'recording') return;
    vlRecordingCancelled = true;
    vlRecorder.stop();
}

function discardLibraryRecording() {
    vlPendingBlob = null;
    vlPendingDurationSeconds = null;
    document.getElementById('vl-record-naming').style.display = 'none';
    document.getElementById('vl-idle-actions').style.display = 'flex';
}

// Upload de arquivo do computador — reaproveita a mesma etapa de "dar um nome
// e salvar" da gravação; a conversão pro formato de voz nativa (OGG/Opus)
// acontece no servidor, igual pra qualquer áudio gravado no navegador.
function handleLibraryFileUpload(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    input.value = '';

    vlPendingBlob = file;
    vlPendingDurationSeconds = null;

    document.getElementById('vl-idle-actions').style.display = 'none';
    const namingEl = document.getElementById('vl-record-naming');
    const nameInput = document.getElementById('vl-record-name-input');
    if (nameInput) {
        nameInput.value = file.name.replace(/\.[^.]+$/, '');
        nameInput.focus();
        nameInput.select();
    }
    if (namingEl) namingEl.style.display = 'flex';
}

async function saveLibraryRecording() {
    if (!vlPendingBlob) return;
    const nameInput = document.getElementById('vl-record-name-input');
    const nome = nameInput ? nameInput.value.trim() : '';
    if (!nome) {
        alert('Digite um nome pra esse áudio.');
        return;
    }

    const reader = new FileReader();
    reader.onload = async () => {
        try {
            const res = await fetch('/api/voice-library', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nome, audio: reader.result, duration_seconds: vlPendingDurationSeconds })
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json.error || 'Erro ao salvar áudio');

            vlPendingBlob = null;
            vlPendingDurationSeconds = null;
            document.getElementById('vl-record-naming').style.display = 'none';
            document.getElementById('vl-idle-actions').style.display = 'flex';
            if (typeof showToast === 'function') showToast('Áudio salvo na biblioteca!', 'success');
            await loadVoiceLibrary();
        } catch (e) {
            alert(e.message);
        }
    };
    reader.readAsDataURL(vlPendingBlob);
}

function handleChatFileUpload(input, type) {
    const file = input.files && input.files[0];
    if (!file || !window.currentActiveChat) return;

    const reader = new FileReader();
    reader.onload = async function(e) {
        let fileData = e.target.result;

        const isImage = type === 'image' || (file.type && file.type.startsWith('image/'));
        if (isImage) {
            pendingImageFile = { fileData, fileName: file.name };
            openImagePreviewModal(fileData);
            input.value = '';
            return;
        }

        let payload = fileData;
        if (file.name) {
            payload = `[FILE:${file.name}]\n` + fileData;
        }
        await sendCustomChatMessage(payload, file.name);
        input.value = '';
    };
    reader.readAsDataURL(file);
}

function getAttendantStorageKey(key) {
    let u = (typeof loggedUser !== 'undefined' && loggedUser && loggedUser.username) ? loggedUser.username : null;
    if (!u) {
        try {
            const saved = JSON.parse(localStorage.getItem('crm_user'));
            if (saved) u = saved.username;
        } catch(e) {}
    }
    return u ? `${key}_${u}` : key;
}

function getAttendantSignature() {
    const isEnabled = localStorage.getItem(getAttendantStorageKey('crm_auto_signature_enabled')) !== 'false';
    if (!isEnabled) return '';

    let displayName = localStorage.getItem(getAttendantStorageKey('crm_attendant_display_name'));
    if (!displayName) {
        if (typeof loggedUser !== 'undefined' && loggedUser) {
            displayName = loggedUser.nome || loggedUser.name || loggedUser.username || 'Fabrício';
        } else {
            try {
                const saved = JSON.parse(localStorage.getItem('crm_user'));
                if (saved) displayName = saved.nome || saved.name || saved.username || 'Fabrício';
            } catch(e) {}
        }
    }
    
    if (!displayName) displayName = 'Fabrício';
    displayName = displayName.charAt(0).toUpperCase() + displayName.slice(1);

    const clinicName = localStorage.getItem(getAttendantStorageKey('crm_clinic_name')) || 'Natuclinic';

    return `_${displayName} – ${clinicName}_`;
}

// A mensagem do paciente vem primeiro, a assinatura entra depois — não antes.
function appendAttendantSignature(text) {
    const signature = getAttendantSignature();
    if (!signature) return text;
    return `${text}\n\n${signature}`;
}

let activeSettingsTab = 'crm';
let isFetchingWaProfile = false;
let hasLoadedWaProfile = false;

function switchSettingsTab(tab) {
    activeSettingsTab = tab;

    const tabs = {
        crm: { tabEl: document.getElementById('settings-tab-crm'), panelEl: document.getElementById('settings-panel-crm') },
        whatsapp: { tabEl: document.getElementById('settings-tab-whatsapp'), panelEl: document.getElementById('settings-panel-whatsapp') },
        unidades: { tabEl: document.getElementById('settings-tab-unidades'), panelEl: document.getElementById('settings-panel-unidades') }
    };

    Object.entries(tabs).forEach(([key, { tabEl, panelEl }]) => {
        const isActive = key === tab;
        if (tabEl) {
            tabEl.classList.toggle('active', isActive);
            tabEl.style.borderBottom = isActive ? '2px solid var(--accent-success)' : '2px solid transparent';
            tabEl.style.color = isActive ? 'var(--accent-success)' : 'var(--text-muted)';
        }
        if (panelEl) panelEl.style.display = isActive ? 'flex' : 'none';
    });

    if (tab === 'whatsapp') {
        fetchWhatsAppBusinessProfile();
    } else if (tab === 'unidades') {
        loadUnidades();
    }
}

async function fetchWhatsAppBusinessProfile() {
    if (isFetchingWaProfile || hasLoadedWaProfile) return;
    isFetchingWaProfile = true;
    
    const loadingEl = document.getElementById('wa-profile-loading');
    const formEl = document.getElementById('wa-profile-form');
    
    if (loadingEl) {
        loadingEl.style.display = 'flex';
        loadingEl.innerHTML = `
            <span class="amicro-loader" style="font-size: 1.5rem; color: var(--accent-success);"><span></span><span></span><span></span></span>
            <span>Buscando informações comerciais na Meta API...</span>
        `;
    }
    if (formEl) formEl.style.display = 'none';
    
    try {
        const res = await fetch('/api/whatsapp/business-profile');
        const json = await res.json();
        
        if (json.success && json.data) {
            const data = json.data;
            
            const addrInput = document.getElementById('setting-wa-address');
            const descInput = document.getElementById('setting-wa-description');
            const emailInput = document.getElementById('setting-wa-email');
            const web1Input = document.getElementById('setting-wa-website-1');
            const web2Input = document.getElementById('setting-wa-website-2');
            const verticalSelect = document.getElementById('setting-wa-vertical');
            
            if (addrInput) addrInput.value = data.address || '';
            if (descInput) descInput.value = data.description || '';
            if (emailInput) emailInput.value = data.email || '';
            if (verticalSelect) verticalSelect.value = data.vertical || 'OTHER';
            
            if (Array.isArray(data.websites)) {
                if (web1Input) web1Input.value = data.websites[0] || '';
                if (web2Input) web2Input.value = data.websites[1] || '';
            } else {
                if (web1Input) web1Input.value = '';
                if (web2Input) web2Input.value = '';
            }
            
            hasLoadedWaProfile = true;
            if (loadingEl) loadingEl.style.display = 'none';
            if (formEl) formEl.style.display = 'flex';
        } else {
            throw new Error(json.error || 'Erro ao carregar dados do perfil');
        }
    } catch(e) {
        console.error("Erro ao carregar perfil do WhatsApp:", e);
        if (loadingEl) {
            loadingEl.innerHTML = `
                <div style="color: var(--accent-danger); display: flex; flex-direction: column; gap: 0.5rem; align-items: center; justify-content: center; padding: 1rem;">
                    <i class="fa-solid fa-triangle-exclamation" style="font-size: 1.5rem; margin-bottom: 0.2rem;"></i>
                    <span>Falha ao carregar perfil: ${e.message}</span>
                    <button type="button" onclick="hasLoadedWaProfile=false; isFetchingWaProfile=false; fetchWhatsAppBusinessProfile()" style="margin-top: 0.5rem; background: var(--accent-success); border: none; color: #fff; padding: 0.4rem 0.8rem; border-radius: 6px; font-size: 0.8rem; cursor: pointer; font-weight: 600;"><i class="fa-solid fa-rotate-right"></i> Tentar Novamente</button>
                </div>
            `;
        }
    } finally {
        isFetchingWaProfile = false;
    }
}

function openSettingsModal() {
    const modal = document.getElementById('modal-settings');
    if (!modal) return;

    // Reseta abas e estados
    switchSettingsTab('crm');
    hasLoadedWaProfile = false;
    isFetchingWaProfile = false;

    let savedName = localStorage.getItem(getAttendantStorageKey('crm_attendant_display_name'));
    if (!savedName) {
        if (typeof loggedUser !== 'undefined' && loggedUser) {
            savedName = loggedUser.nome || loggedUser.name || loggedUser.username || '';
        } else {
            try {
                const saved = JSON.parse(localStorage.getItem('crm_user'));
                if (saved) savedName = saved.nome || saved.name || saved.username || '';
            } catch(e) {}
        }
    }

    const nameInput = document.getElementById('setting-attendant-name');
    const clinicInput = document.getElementById('setting-clinic-name');
    const autoSigCheck = document.getElementById('setting-auto-signature');

    if (nameInput) nameInput.value = savedName || (typeof loggedUser !== 'undefined' && loggedUser ? (loggedUser.nome || loggedUser.username) : 'Fabrício');
    if (clinicInput) clinicInput.value = localStorage.getItem(getAttendantStorageKey('crm_clinic_name')) || 'Natuclinic';
    if (autoSigCheck) autoSigCheck.checked = localStorage.getItem(getAttendantStorageKey('crm_auto_signature_enabled')) !== 'false';

    updateSignaturePreview();
    modal.style.display = 'flex';
    modal.classList.add('active');
}

function closeSettingsModal() {
    const modal = document.getElementById('modal-settings');
    if (modal) {
        modal.classList.remove('active');
        modal.style.display = 'none';
    }
}

function updateSignaturePreview() {
    const nameInput = document.getElementById('setting-attendant-name');
    const clinicInput = document.getElementById('setting-clinic-name');
    const autoSigCheck = document.getElementById('setting-auto-signature');
    const previewBox = document.getElementById('signature-preview-box');

    if (!previewBox) return;

    const greeting = "Olá! Como posso te ajudar hoje?";
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

    const isEnabled = autoSigCheck ? autoSigCheck.checked : true;
    if (!isEnabled) {
        previewBox.textContent = greeting;
        return;
    }

    const name = (nameInput && nameInput.value.trim()) ? nameInput.value.trim() : 'Fabrício';
    const clinic = (clinicInput && clinicInput.value.trim()) ? clinicInput.value.trim() : 'Natuclinic';

    // Prévia já renderiza o itálico como o WhatsApp faria com _texto_
    previewBox.innerHTML = `${esc(greeting)}<br><br><em style="opacity:.92;">${esc(name)} – ${esc(clinic)}</em>`;
}

async function saveCRMSettings() {
    const nameInput = document.getElementById('setting-attendant-name');
    const clinicInput = document.getElementById('setting-clinic-name');
    const autoSigCheck = document.getElementById('setting-auto-signature');

    // Se a aba carregou e editamos o perfil do WhatsApp, tenta salvar na Meta primeiro
    if (hasLoadedWaProfile) {
        const saveBtn = document.querySelector('button[onclick="saveCRMSettings()"]');
        const origText = saveBtn ? saveBtn.innerHTML : '';
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.innerHTML = '<span class="amicro-loader"><span></span><span></span><span></span></span> Salvando Meta API...';
        }
        
        try {
            const addr = document.getElementById('setting-wa-address')?.value.trim() || '';
            const desc = document.getElementById('setting-wa-description')?.value.trim() || '';
            const email = document.getElementById('setting-wa-email')?.value.trim() || '';
            const web1 = document.getElementById('setting-wa-website-1')?.value.trim() || '';
            const web2 = document.getElementById('setting-wa-website-2')?.value.trim() || '';
            const vertical = document.getElementById('setting-wa-vertical')?.value || 'OTHER';
            
            const websites = [];
            if (web1) websites.push(web1);
            if (web2) websites.push(web2);
            
            const res = await fetch('/api/whatsapp/business-profile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    address: addr,
                    description: desc,
                    email: email,
                    vertical: vertical,
                    websites: websites
                })
            });
            const json = await res.json();
            
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Erro desconhecido');
            }
            
            if (typeof showToast === 'function') {
                showToast('Perfil comercial do WhatsApp atualizado com sucesso!', 'success');
            }
        } catch(e) {
            console.error("Erro ao salvar perfil comercial do WhatsApp na Meta:", e);
            if (typeof showToast === 'function') {
                showToast('Erro ao salvar na Meta: ' + e.message, 'danger');
            } else {
                alert('Erro ao salvar na Meta: ' + e.message);
            }
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.innerHTML = origText;
            }
            return; // Impede fechar o modal
        }
    }

    if (nameInput) localStorage.setItem(getAttendantStorageKey('crm_attendant_display_name'), nameInput.value.trim());
    if (clinicInput) localStorage.setItem(getAttendantStorageKey('crm_clinic_name'), clinicInput.value.trim());
    if (autoSigCheck) localStorage.setItem(getAttendantStorageKey('crm_auto_signature_enabled'), autoSigCheck.checked ? 'true' : 'false');

    closeSettingsModal();
    
    // Só exibe a toast se não tiver mostrado antes pelo perfil do WhatsApp (para não duplicar)
    if (!hasLoadedWaProfile) {
        if (typeof showToast === 'function') {
            showToast('Configurações do atendente salvas com sucesso!', 'success');
        } else {
            alert('Configurações do atendente salvas com sucesso!');
        }
    }
}

// ==========================================
// CAMPANHAS (Origem de Leads / UTMs)
// ==========================================
let cachedCampaigns = [];
let editingCampaignId = null;

function campaignCanalLabel(canal) {
    return { fisico: 'Físico (QR/Link)', google: 'Google Ads', instagram: 'Instagram', site: 'Site' }[canal] || canal;
}

function campaignCanalIcon(canal) {
    return {
        fisico: 'fa-solid fa-qrcode',
        google: 'fa-brands fa-google',
        instagram: 'fa-brands fa-instagram',
        site: 'fa-solid fa-globe'
    }[canal] || 'fa-solid fa-bullhorn';
}

function fmtMoney(v) {
    return 'R$ ' + (parseFloat(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
}

function onCampaignCanalChange() {
    const canal = document.getElementById('new-campaign-canal')?.value;
    const fisicoFields = document.getElementById('campaign-fields-fisico');
    const onlineFields = document.getElementById('campaign-fields-online');
    const isFisico = canal === 'fisico';
    if (fisicoFields) fisicoFields.style.display = isFisico ? 'block' : 'none';
    if (onlineFields) onlineFields.style.display = isFisico ? 'none' : 'flex';

    document.querySelectorAll('.utm-channel-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.canal === canal);
    });
}

function pickCampaignCanal(canal) {
    const select = document.getElementById('new-campaign-canal');
    if (select) select.value = canal;
    onCampaignCanalChange();
}

function toggleUtmSnippetPanel() {
    const panel = document.getElementById('utm-snippet-panel');
    if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function copyUtmSnippet() {
    const code = document.getElementById('utm-snippet-code')?.innerText;
    if (!code) return;
    navigator.clipboard.writeText(code).then(() => {
        if (typeof showToast === 'function') showToast('Código copiado!', 'success');
    }).catch(() => {
        if (typeof showToast === 'function') showToast('Não foi possível copiar.', 'danger');
    });
}

async function loadCampaigns() {
    const listEl = document.getElementById('campaigns-list');
    if (!listEl) return;
    listEl.innerHTML = `<div style="text-align:center; padding: 1.5rem 0; color: var(--text-muted); font-size: 0.85rem;"><span class="amicro-loader"><span></span><span></span><span></span></span> Carregando campanhas...</div>`;

    try {
        const res = await fetch('/api/campaigns');
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Erro ao carregar campanhas');

        cachedCampaigns = json.campaigns || [];
        renderCampaignsList();
        renderTopCampaignsRanking();
        renderUtmKpiRow();
    } catch (e) {
        console.error('Erro ao carregar campanhas:', e);
        listEl.innerHTML = `<div style="text-align:center; padding: 1.5rem 0; color: var(--accent-danger); font-size: 0.85rem;">Falha ao carregar campanhas: ${escapeHtml(e.message)}</div>`;
    }
}

function renderUtmKpiRow() {
    const box = document.getElementById('utm-kpi-row');
    if (!box) return;

    const ativas = cachedCampaigns.filter(c => c.status === 'ativa');
    const totalLeads = cachedCampaigns.reduce((s, c) => s + (c.leads_count || 0), 0);
    const totalScans = cachedCampaigns.reduce((s, c) => s + (c.clicks_count || 0), 0);
    const totalInvestido = cachedCampaigns.reduce((s, c) => s + (parseFloat(c.valor_investido) || 0), 0);

    const chips = [
        { label: 'Campanhas ativas', value: ativas.length },
        { label: 'Leads gerados', value: totalLeads },
        { label: 'Scans de QR/link', value: totalScans },
        { label: 'Investido no total', value: fmtMoney(totalInvestido) }
    ];

    box.innerHTML = chips.map(c => `
        <div class="utm-kpi-chip">
            <span class="utm-kpi-value">${c.value}</span>
            <span class="utm-kpi-label">${c.label}</span>
        </div>
    `).join('');
}

function renderTopCampaignsRanking() {
    const box = document.getElementById('campaigns-top-ranking');
    if (!box) return;

    const top = cachedCampaigns
        .filter(c => c.status === 'ativa' && c.convertidos_count > 0)
        .sort((a, b) => b.convertidos_count - a.convertidos_count)
        .slice(0, 3);

    if (top.length === 0) {
        box.style.display = 'none';
        box.innerHTML = '';
        return;
    }

    box.style.display = 'block';
    const medals = ['🥇', '🥈', '🥉'];
    box.innerHTML = `
        <div class="utm-panel" style="padding: 1.1rem 1.25rem;">
            <h3 style="color: var(--text-main); font-size: 0.92rem; margin: 0 0 0.7rem 0; display:flex; align-items:center; gap:0.5rem;"><i class="fa-solid fa-trophy" style="color: #f59e0b;"></i> Top Campanhas (vendas)</h3>
            <div style="display: flex; flex-direction: column; gap: 0.4rem;">
                ${top.map((c, idx) => `
                    <div style="display: flex; align-items: center; gap: 0.8rem; padding: 0.45rem 0.65rem; background: var(--bg-main); border-radius: 8px;">
                        <div style="font-size: 1.05rem;">${medals[idx]}</div>
                        <div style="flex: 1; min-width: 0; font-weight: 600; color: var(--text-main); font-size: 0.83rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(c.nome)}</div>
                        <div style="font-size: 0.76rem; color: var(--accent-success); font-weight: 700;">${c.convertidos_count} venda(s)</div>
                        <div style="font-size: 0.76rem; color: var(--text-muted);">${c.leads_count} lead(s)</div>
                    </div>
                `).join('')}
            </div>
        </div>`;
}

function getFilteredCampaigns() {
    const search = (document.getElementById('campaign-filter-search')?.value || '').trim().toLowerCase();
    const canalFilter = document.getElementById('campaign-filter-canal')?.value || '';
    const statusFilter = document.getElementById('campaign-filter-status')?.value || '';

    return cachedCampaigns.filter(c => {
        if (search && !c.nome.toLowerCase().includes(search)) return false;
        if (canalFilter && c.canal !== canalFilter) return false;
        if (statusFilter && c.status !== statusFilter) return false;
        return true;
    });
}

function renderCampaignsList() {
    const listEl = document.getElementById('campaigns-list');
    if (!listEl) return;

    const filtered = getFilteredCampaigns();

    if (filtered.length === 0) {
        const empty = cachedCampaigns.length === 0;
        listEl.innerHTML = `<div class="utm-empty-state" style="flex: 1; justify-content: center;">
            <i class="fa-solid fa-${empty ? 'bullseye' : 'filter-circle-xmark'}" style="font-size: 1.8rem;"></i>
            <strong style="color: var(--text-main); font-size: 0.92rem;">${empty ? 'Nenhuma campanha ainda' : 'Nenhuma campanha encontrada'}</strong>
            <span style="max-width: 320px;">${empty ? 'Preencha o formulário ao lado e clique em "Criar Campanha" para começar a rastrear a origem dos seus leads.' : 'Nenhuma campanha corresponde aos filtros selecionados.'}</span>
        </div>`;
        return;
    }

    listEl.innerHTML = filtered.map(c => {
        const isArquivada = c.status === 'arquivada';
        const displayLink = c.short_link || c.link;
        const hasInvestment = c.valor_investido > 0;

        const statsChips = [
            `<span title="Leads gerados"><i class="fa-solid fa-user-plus"></i> ${c.leads_count} lead(s)</span>`,
            `<span title="Viraram venda" style="color: var(--accent-success);"><i class="fa-solid fa-check"></i> ${c.convertidos_count} venda(s)</span>`
        ];
        if (c.canal === 'fisico') {
            statsChips.unshift(`<span title="Vezes que o QR/link foi acessado"><i class="fa-solid fa-eye"></i> ${c.clicks_count} scan(s)</span>`);
        }
        if (c.valor_gerado > 0) {
            statsChips.push(`<span title="Receita gerada" style="color: var(--accent-success);">${fmtMoney(c.valor_gerado)}</span>`);
        }
        if (hasInvestment) {
            statsChips.push(`<span title="Investido">Invest.: ${fmtMoney(c.valor_investido)}</span>`);
            if (c.cpl !== null) statsChips.push(`<span title="Custo por lead">CPL: ${fmtMoney(c.cpl)}</span>`);
            if (c.roi !== null) statsChips.push(`<span title="Retorno sobre investimento" style="color: ${c.roi >= 0 ? 'var(--accent-success)' : 'var(--accent-danger)'};">ROI: ${c.roi.toFixed(0)}%</span>`);
        }

        return `
        <div style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 10px; padding: 0.8rem 0.9rem; display: flex; gap: 0.8rem; align-items: center; opacity: ${isArquivada ? '0.55' : '1'};">
            ${c.canal === 'fisico' ? `<img src="/api/campaigns/${encodeURIComponent(c.id)}/qrcode" alt="QR Code" style="width: 56px; height: 56px; border-radius: 6px; background: #fff; padding: 3px; flex-shrink: 0; cursor: pointer;" onclick="openImagePreviewModal(this.src)">` : `<div style="width: 56px; height: 56px; border-radius: 6px; background: var(--bg-main); display:flex; align-items:center; justify-content:center; flex-shrink: 0;"><i class="${campaignCanalIcon(c.canal)}" style="font-size: 1.3rem; color: var(--text-muted);"></i></div>`}
            <div style="flex: 1; min-width: 0;">
                <div style="font-weight: 600; font-size: 0.88rem; color: var(--text-main); display:flex; align-items:center; gap:0.4rem; flex-wrap: wrap;">
                    ${escapeHtml(c.nome)}
                    <span style="font-size: 0.7rem; font-weight: 600; color: var(--text-muted); background: var(--bg-main); padding: 0.1rem 0.45rem; border-radius: 6px;">${campaignCanalLabel(c.canal)}</span>
                    ${isArquivada ? `<span style="font-size: 0.7rem; font-weight: 600; color: var(--accent-danger);">Arquivada</span>` : ''}
                </div>
                <div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 0.2rem; word-break: break-all;">${escapeHtml(displayLink)}</div>
                <div style="font-size: 0.76rem; color: var(--text-muted); margin-top: 0.35rem; display: flex; gap: 0.7rem; flex-wrap: wrap; font-weight: 600;">${statsChips.join('')}</div>
            </div>
            <div style="display: flex; flex-direction: column; gap: 0.35rem; flex-shrink: 0;">
                <button type="button" onclick="copyCampaignLink('${c.id}')" title="Copiar link" style="background: var(--bg-main); border: 1px solid var(--border-color); color: var(--text-main); padding: 0.35rem 0.5rem; border-radius: 6px; cursor: pointer; font-size: 0.78rem;"><i class="fa-solid fa-copy"></i></button>
                ${c.canal === 'fisico' ? `<button type="button" onclick="downloadCampaignQR('${c.id}', ${escapeHtml(JSON.stringify(c.nome))})" title="Baixar QR Code" style="background: var(--bg-main); border: 1px solid var(--border-color); color: var(--text-main); padding: 0.35rem 0.5rem; border-radius: 6px; cursor: pointer; font-size: 0.78rem;"><i class="fa-solid fa-download"></i></button>` : ''}
                <button type="button" onclick="startEditCampaign('${c.id}')" title="Editar" style="background: var(--bg-main); border: 1px solid var(--border-color); color: var(--text-main); padding: 0.35rem 0.5rem; border-radius: 6px; cursor: pointer; font-size: 0.78rem;"><i class="fa-solid fa-pen"></i></button>
                <button type="button" onclick="duplicateCampaign('${c.id}')" title="Duplicar (criar campanha parecida)" style="background: var(--bg-main); border: 1px solid var(--border-color); color: var(--text-main); padding: 0.35rem 0.5rem; border-radius: 6px; cursor: pointer; font-size: 0.78rem;"><i class="fa-solid fa-clone"></i></button>
                <button type="button" onclick="toggleCampaignStatus('${c.id}', '${isArquivada ? 'ativa' : 'arquivada'}')" title="${isArquivada ? 'Reativar' : 'Arquivar'}" style="background: var(--bg-main); border: 1px solid var(--border-color); color: var(--text-main); padding: 0.35rem 0.5rem; border-radius: 6px; cursor: pointer; font-size: 0.78rem;"><i class="fa-solid fa-${isArquivada ? 'rotate-left' : 'box-archive'}"></i></button>
                <button type="button" onclick="deleteCampaign('${c.id}')" title="Excluir" style="background: var(--bg-main); border: 1px solid var(--border-color); color: var(--accent-danger); padding: 0.35rem 0.5rem; border-radius: 6px; cursor: pointer; font-size: 0.78rem;"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>`;
    }).join('');
}

function copyCampaignLink(id) {
    const campaign = cachedCampaigns.find(c => c.id === id);
    if (!campaign) return;
    navigator.clipboard.writeText(campaign.short_link || campaign.link).then(() => {
        if (typeof showToast === 'function') showToast('Link copiado!', 'success');
    }).catch(() => {
        if (typeof showToast === 'function') showToast('Não foi possível copiar o link.', 'danger');
    });
}

async function downloadCampaignQR(id, nome) {
    try {
        const res = await fetch(`/api/campaigns/${encodeURIComponent(id)}/qrcode`);
        if (!res.ok) throw new Error('Erro ao gerar QR code');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `qrcode-${nome.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    } catch (e) {
        if (typeof showToast === 'function') showToast(e.message, 'danger'); else alert(e.message);
    }
}

async function toggleCampaignStatus(id, newStatus) {
    try {
        const res = await fetch(`/api/campaigns/${encodeURIComponent(id)}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Erro ao atualizar campanha');
        await loadCampaigns();
    } catch (e) {
        if (typeof showToast === 'function') showToast(e.message, 'danger'); else alert(e.message);
    }
}

async function deleteCampaign(id) {
    if (!await customConfirm('Excluir esta campanha? O link e o QR code deixarão de funcionar pra reconhecimento automático de origem.', 'Excluir Campanha')) return;
    try {
        const res = await fetch(`/api/campaigns/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json()).error || 'Erro ao excluir campanha');
        if (editingCampaignId === id) cancelEditCampaign();
        await loadCampaigns();
    } catch (e) {
        if (typeof showToast === 'function') showToast(e.message, 'danger'); else alert(e.message);
    }
}

function startEditCampaign(id) {
    const c = cachedCampaigns.find(x => x.id === id);
    if (!c) return;

    editingCampaignId = id;

    document.getElementById('new-campaign-nome').value = c.nome;
    document.getElementById('new-campaign-investimento').value = c.valor_investido || '';

    // Canal não pode mudar depois de criada (o link é montado em cima dele)
    const canalGroup = document.getElementById('campaign-canal-group');
    if (canalGroup) canalGroup.style.display = 'none';
    document.getElementById('new-campaign-canal').value = c.canal;
    onCampaignCanalChange();

    if (c.canal === 'fisico') {
        document.getElementById('new-campaign-trigger').value = c.trigger_text || '';
    } else {
        document.getElementById('new-campaign-destino').value = c.destino_url || '';
        document.getElementById('new-campaign-utm-source').value = c.utm_source || '';
        document.getElementById('new-campaign-utm-medium').value = c.utm_medium || '';
        document.getElementById('new-campaign-utm-campaign').value = c.utm_campaign || '';
    }

    document.getElementById('campaign-form-title').innerHTML = '<i class="fa-solid fa-pen" style="color: #38bdf8;"></i> Editar Campanha';
    const btn = document.getElementById('btn-create-campaign');
    if (btn) btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Salvar Alterações';
    const cancelBtn = document.getElementById('btn-cancel-edit-campaign');
    if (cancelBtn) cancelBtn.style.display = 'inline-flex';

    document.getElementById('view-origem-leads')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function duplicateCampaign(id) {
    const c = cachedCampaigns.find(x => x.id === id);
    if (!c) return;

    cancelEditCampaign();

    document.getElementById('new-campaign-nome').value = `${c.nome} (cópia)`;
    document.getElementById('new-campaign-investimento').value = '';
    document.getElementById('new-campaign-canal').value = c.canal;
    onCampaignCanalChange();

    if (c.canal === 'fisico') {
        document.getElementById('new-campaign-trigger').value = '';
    } else {
        document.getElementById('new-campaign-destino').value = c.destino_url || '';
        document.getElementById('new-campaign-utm-source').value = c.utm_source || '';
        document.getElementById('new-campaign-utm-medium').value = c.utm_medium || '';
    }

    document.getElementById('view-origem-leads')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (typeof showToast === 'function') showToast('Campanha duplicada no formulário — ajuste o nome e crie.', 'success');
}

function cancelEditCampaign() {
    editingCampaignId = null;
    ['new-campaign-nome', 'new-campaign-trigger', 'new-campaign-destino', 'new-campaign-utm-source', 'new-campaign-utm-medium', 'new-campaign-utm-campaign', 'new-campaign-investimento'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const canalGroup = document.getElementById('campaign-canal-group');
    if (canalGroup) canalGroup.style.display = 'block';
    document.getElementById('new-campaign-canal').value = 'fisico';
    onCampaignCanalChange();

    document.getElementById('campaign-form-title').innerHTML = '<i class="fa-solid fa-circle-plus" style="color: #38bdf8;"></i> Nova Campanha';
    const btn = document.getElementById('btn-create-campaign');
    if (btn) btn.innerHTML = '<i class="fa-solid fa-plus"></i> Criar Campanha';
    const cancelBtn = document.getElementById('btn-cancel-edit-campaign');
    if (cancelBtn) cancelBtn.style.display = 'none';
}

async function submitNewCampaign() {
    const nome = document.getElementById('new-campaign-nome')?.value.trim();
    const canal = document.getElementById('new-campaign-canal')?.value;

    if (!nome) {
        if (typeof showToast === 'function') showToast('Digite um nome pra campanha.', 'danger'); else alert('Digite um nome pra campanha.');
        return;
    }

    const body = { nome, valor_investido: document.getElementById('new-campaign-investimento')?.value || 0 };
    if (!editingCampaignId) body.canal = canal;

    if (canal === 'fisico') {
        body.trigger_text = document.getElementById('new-campaign-trigger')?.value.trim() || '';
    } else {
        const destino = document.getElementById('new-campaign-destino')?.value.trim();
        if (!destino) {
            if (typeof showToast === 'function') showToast('Informe a URL de destino.', 'danger'); else alert('Informe a URL de destino.');
            return;
        }
        body.destino_url = destino;
        body.utm_source = document.getElementById('new-campaign-utm-source')?.value.trim() || '';
        body.utm_medium = document.getElementById('new-campaign-utm-medium')?.value.trim() || '';
        body.utm_campaign = document.getElementById('new-campaign-utm-campaign')?.value.trim() || '';
    }

    const btn = document.getElementById('btn-create-campaign');
    const origText = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="amicro-loader"><span></span><span></span><span></span></span> Salvando...'; }

    try {
        const isEditing = !!editingCampaignId;
        const res = await fetch(isEditing ? `/api/campaigns/${encodeURIComponent(editingCampaignId)}` : '/api/campaigns', {
            method: isEditing ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Erro ao salvar campanha');

        if (isEditing) cancelEditCampaign();
        else ['new-campaign-nome', 'new-campaign-trigger', 'new-campaign-destino', 'new-campaign-utm-source', 'new-campaign-utm-medium', 'new-campaign-utm-campaign', 'new-campaign-investimento'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });

        if (typeof showToast === 'function') showToast(isEditing ? 'Campanha atualizada com sucesso!' : 'Campanha criada com sucesso!', 'success');
        await loadCampaigns();
    } catch (e) {
        if (btn) btn.innerHTML = origText;
        if (typeof showToast === 'function') showToast(e.message, 'danger'); else alert(e.message);
    } finally {
        if (btn) btn.disabled = false;
    }
}

function openImagePreviewModal(src) {
    const modal = document.getElementById('modal-image-preview');
    const img = document.getElementById('image-preview-thumbnail');
    const captionInput = document.getElementById('image-preview-caption');
    if (!modal || !img) return;

    img.src = src;
    if (captionInput) captionInput.value = '';
    modal.style.display = 'flex';
}

function closeImagePreviewModal() {
    const modal = document.getElementById('modal-image-preview');
    if (modal) modal.style.display = 'none';
    pendingImageFile = null;
}

async function confirmSendImageWithCaption() {
    if (!pendingImageFile) return;
    const captionInput = document.getElementById('image-preview-caption');
    let caption = captionInput ? captionInput.value.trim() : '';

    if (caption) {
        caption = appendAttendantSignature(caption);
    } else {
        caption = getAttendantSignature();
    }

    let payload = pendingImageFile.fileData;
    if (caption) {
        payload = `[CAPTION:${caption}]\n[FILE:${pendingImageFile.fileName}]\n` + pendingImageFile.fileData;
    } else if (pendingImageFile.fileName) {
        payload = `[FILE:${pendingImageFile.fileName}]\n` + pendingImageFile.fileData;
    }

    const fn = pendingImageFile.fileName;
    closeImagePreviewModal();
    await sendCustomChatMessage(payload, fn, caption);
}

async function sendCustomChatMessage(msgText, filename = '', caption = '', isVoiceRecording = false) {
    if (!msgText || !window.currentActiveChat) return;
    if (window.chatLockState && window.chatLockState.locked) {
        alert('Esta conversa está em atendimento por outro atendente. Aguarde ela ficar disponível.');
        return;
    }

    const activeLead = typeof leads !== 'undefined'
        ? leads.find(l => isSamePhone(l.telefone, window.currentActiveChat.phone))
        : null;
    if (activeLead && !(await claimLeadConversation(activeLead.id))) return;

    const popup = document.getElementById('quick-replies-popup');
    if (popup) popup.style.display = 'none';

    const msgsContainer = document.getElementById('chat-active-messages');
    const previewHtml = renderChatMessageContent(msgText);

    msgsContainer.innerHTML += `
        <div style="display: flex; flex-direction: column; align-items: flex-end; margin-bottom: 0.6rem; opacity: 0.7;">
            <div style="background: #0f766e; border: 1px solid rgba(255,255,255,0.18); box-shadow: none; color: #fff; padding: 0.8rem 1rem; border-radius: 12px; max-width: 80%;">
                ${previewHtml}
            </div>
            <span style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.2rem;">Enviando...</span>
        </div>
    `;
    msgsContainer.scrollTop = msgsContainer.scrollHeight;

    if (window.currentActiveChat && window.currentActiveChat.phone && typeof leads !== 'undefined') {
        const phone = window.currentActiveChat.phone;
        let lead = leads.find(l =>
            l.telefone === phone ||
            l.telefone === '+' + phone ||
            (l.telefone && l.telefone.includes(phone)) ||
            (phone && phone.includes(l.telefone))
        );

        if (lead) {
            if (!lead.column || lead.column === 'col-entrada') {
                lead.column = 'col-contatado';
                if (typeof renderBoard === 'function') renderBoard();
                if (typeof updateChatStageUI === 'function') updateChatStageUI(lead.column);
                fetch(`/api/leads/${lead.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ column_id: 'col-contatado' })
                }).catch(console.error);
            }
        }
    }

    try {
        const quotedId = window.pendingReplyTo ? window.pendingReplyTo.id : undefined;
        cancelReplyTo();

        const res = await fetch('/api/whatsapp/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                to: window.currentActiveChat.phone,
                message: msgText,
                filename: filename,
                caption: caption,
                quoted_id: quotedId,
                isVoiceRecording: isVoiceRecording
            })
        });

        const json = await res.json();
        if (json.success) {
            openChat(window.currentActiveChat.phone, window.currentActiveChat.name, true);
        } else {
            alert("Erro ao enviar mídia: " + (json.error || "Tente novamente"));
            openChat(window.currentActiveChat.phone, window.currentActiveChat.name, true);
        }
    } catch(err) {
        alert("Erro de conexão ao enviar mídia.");
        openChat(window.currentActiveChat.phone, window.currentActiveChat.name, true);
    }
}

async function deleteChatMessageForEveryone(messageId) {
    if (!messageId) return;
    if (!await customConfirm("Deseja realmente apagar esta mensagem?", "Apagar Mensagem")) return;

    try {
        const res = await fetch('/api/whatsapp/delete-message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message_id: messageId })
        });

        const json = await res.json();
        if (json.success) {
            if (window.currentActiveChat) {
                openChat(window.currentActiveChat.phone, window.currentActiveChat.name, true);
            }
        } else {
            alert("Erro ao apagar mensagem: " + (json.error || "Tente novamente"));
        }
    } catch(e) {
        alert("Erro de conexão ao tentar apagar a mensagem.");
    }
}

// ESC fecha a conversa aberta na aba de Atendimento — mas não quando algum popup/modal
// flutuante estiver aberto por cima (nesse caso é ele que deve fechar primeiro).
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!window.currentActiveChat) return;

    const chatView = document.getElementById('view-chat');
    if (!chatView || chatView.style.display === 'none') return;

    const floatingOverlaySelectors = [
        '#quick-replies-popup', '#attach-menu-popup', '#tags-menu-popup',
        '#stage-menu-popup', '#transfer-menu-popup', '#modal-image-preview',
        '.modal-overlay.active'
    ];
    const hasOpenOverlay = floatingOverlaySelectors.some(sel => {
        const el = document.querySelector(sel);
        if (!el) return false;
        return el.classList.contains('active') || getComputedStyle(el).display !== 'none';
    });
    if (hasOpenOverlay) return;

    closeActiveChat();
});

async function openChat(phone, name, silent = false) {
    // Normaliza o número: remove não-dígitos e adiciona 55 se não tiver
    let normalizedPhone = String(phone).replace(/\D/g, '');
    if (normalizedPhone.length >= 10 && !normalizedPhone.startsWith('55')) {
        normalizedPhone = '55' + normalizedPhone;
    }
    phone = normalizedPhone;

    window.currentActiveChat = { phone, name };

    if (!silent) {
        cancelReplyTo();
        window.lastRenderedMessagesSignature = null; // força reconstrução completa numa abertura de verdade
        // Abrir a conversa de verdade limpa a marcação manual de "não lida".
        if (typeof isMarkedUnreadChat === 'function' && isMarkedUnreadChat(phone)) {
            setChatSetting(phone, 'marked_unread', false);
        }
    }
    
    document.getElementById('chat-empty-state').style.display = 'none';
    document.getElementById('chat-active-header').style.display = 'flex';
    document.getElementById('chat-active-messages').style.display = 'flex';
    document.getElementById('chat-active-input').style.display = 'flex';
    // mobile: abre a conversa em tela cheia (esconde a lista)
    document.getElementById('view-chat')?.classList.add('chat-open');
    document.getElementById('view-chat')?.classList.remove('lead-open');

    // Restaura o rascunho salvo dessa conversa, se houver
    const draftInput = document.getElementById('chat-input-text');
    if (draftInput) {
        draftInput.value = getChatDraft(phone);
        if (typeof autoExpandChatInput === 'function') autoExpandChatInput(draftInput);
    }

    const leadPanelEl = document.getElementById('chat-lead-panel');
    if (leadPanelEl) leadPanelEl.style.display = 'flex';
    
    document.getElementById('chat-active-name').textContent = name;
    const phoneNumEl = document.getElementById('chat-active-phone-number');
    if (phoneNumEl) phoneNumEl.textContent = "+" + phone;
    else document.getElementById('chat-active-phone').textContent = "+" + phone;

    const targetChat = (typeof allChatsList !== 'undefined' && Array.isArray(allChatsList))
        ? allChatsList.find(c => isSamePhone(c.phone, phone))
        : null;

    const lastTs = targetChat ? (targetChat.last_timestamp || targetChat.timestamp) : null;
    const lastDir = targetChat ? (targetChat.last_direction || targetChat.direction) : null;
    const onlineInfo = getLeadOnlineStatus(lastTs, lastDir);

    const avatarSlot = document.getElementById('chat-header-avatar-slot');
    if (avatarSlot) {
        avatarSlot.innerHTML = renderAvatarHTML(name, null, onlineInfo.statusClass, 44);
    }

    const onlineStatusEl = document.getElementById('chat-active-online-status');
    if (onlineStatusEl) {
        onlineStatusEl.textContent = onlineInfo.text;
        onlineStatusEl.style.color = onlineInfo.isOnline ? '#22c55e' : '#a1a1aa';
    }
    
    // Marcar mensagens do chat como lidas
    fetch('/api/whatsapp/mark-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
    }).then(() => {
        if (typeof allChatsList !== 'undefined' && Array.isArray(allChatsList)) {
            const found = allChatsList.find(c => isSamePhone(c.phone, phone));
            if (found) {
                found.unread_count = 0;
            }
        }
    }).catch(console.error);
    
    // Ao abrir a conversa, apenas move o lead para "Em Atendimento" quando necessário.
    // A atribuição do atendente acontece somente no envio da primeira mensagem.

    // Só limpa o banner da trava quando é uma abertura de verdade (troca de conversa) —
    // nas atualizações silenciosas (polling a cada 6s da própria conversa já aberta) isso
    // NÃO roda, porque esconder e mostrar o banner de novo a cada 6s é o que causava o
    // "piscar" incômodo. claimLeadConversation() já atualiza o banner sozinho com o
    // resultado real assim que a resposta chega, sem precisar apagar ele antes.
    if (!silent) {
        applyChatLockUI(false);
        stopLeadLockRenewal();
    }

    let activeColumn = 'col-entrada';

    if (typeof leads !== 'undefined') {
        let currentLead = leads.find(l => isSamePhone(l.telefone, phone));

        if (currentLead) {
            if (!silent && (!currentLead.column || currentLead.column === 'col-entrada')) {
                currentLead.column = 'col-contatado';
                if (typeof renderBoard === 'function') renderBoard();
                fetch(`/api/leads/${currentLead.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ column_id: 'col-contatado' })
                }).catch(console.error);
            }

            activeColumn = currentLead.column || 'col-contatado';
        } else if (phone && !silent) {
            // Se o lead ainda não existia no Kanban, cria direto em "Em Atendimento" sem responsável.
            // Só roda numa abertura de verdade (silent=false) — nunca no polling de fundo
            // (a cada 5s, pra atualizar a conversa já aberta), senão um lead apagado
            // enquanto a conversa continua na tela era recriado sozinho a cada poll.
            const newLead = {
                id: Date.now().toString(),
                nome: name && !name.includes('Contato') ? name : 'Lead WhatsApp',
                telefone: phone,
                origem: 'WhatsApp Orgânico',
                column: 'col-contatado',
                owner_id: null
            };
            leads.push(newLead);
            if (typeof renderBoard === 'function') renderBoard();
            activeColumn = 'col-contatado';
            if (typeof saveLeadToServer === 'function') {
                await saveLeadToServer(newLead).catch(console.error);
            }
        }
    }

    updateChatStageUI(activeColumn);
    
    if (typeof leads !== 'undefined') {
        let targetLead = leads.find(l => isSamePhone(l.telefone, phone));
        renderChatTagsUI(targetLead);
        renderLeadInfoPanel(targetLead, phone);
    }

    if(!silent) document.getElementById('chat-active-messages').innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-muted);"><span class="amicro-loader"><span></span><span></span><span></span></span> Carregando mensagens...</div>';
    
    try {
        const res = await fetch(`/api/whatsapp/chat/${phone}`);
        const json = await res.json();
        
        if (json.success && Array.isArray(json.data)) {
            // Compara com o que já está renderizado ANTES de sobrescrever o cache — se nada
            // mudou (nenhuma mensagem nova, nenhum status novo), a atualização silenciosa de
            // fundo (a cada 6s) não reconstrói o HTML das mensagens. Sem isso, todo vídeo/áudio
            // na tela reiniciava sozinho e a lista inteira piscava a cada poll, mesmo sem
            // nenhuma novidade de verdade — só por causa da checagem de status online.
            const newMessagesSignature = JSON.stringify(json.data);
            const messagesUnchanged = silent && window.lastRenderedMessagesSignature === newMessagesSignature;

            window.activeChatMessages = json.data; // Cache global de mensagens

            // Atualiza "Última interação" no painel do lead com a mensagem real mais recente
            // (mais confiável que a allChatsList, que só chega via polling e pode não ter esse número ainda)
            if (typeof leads !== 'undefined') {
                const targetLead = leads.find(l => isSamePhone(l.telefone, phone));
                const lastMsg = json.data.length ? json.data[json.data.length - 1] : null;
                renderLeadInfoPanel(targetLead, phone, lastMsg ? { ts: lastMsg.timestamp, dir: lastMsg.direction } : null);
            }

            if (messagesUnchanged) {
                if (!silent) loadChats(true);
                return;
            }

            let html = '';
            let lastDateStr = '';

            // Agrega reações
            const reactionsMap = {};
            const nonReactionMessages = [];
            json.data.forEach(msg => {
                if (msg.message && msg.message.startsWith('[Reagiu com:')) {
                    const match = msg.message.match(/\[Reagiu com:\s*(.*?)\]/);
                    if (match && msg.quoted_id) {
                        if (match[1]) {
                            reactionsMap[msg.quoted_id] = match[1];
                        } else {
                            delete reactionsMap[msg.quoted_id];
                        }
                    }
                } else {
                    nonReactionMessages.push(msg);
                }
            });
            window.currentReactionsMap = reactionsMap;

            nonReactionMessages.forEach(msg => {
                const currentDateStr = formatFullChatDate(msg.timestamp);

                // Exibe a data no início da conversa e na mudança de dia (sem fundo, apenas ícone e texto)
                if (currentDateStr && currentDateStr !== lastDateStr) {
                    lastDateStr = currentDateStr;
                    html += `
                        <div style="align-self: center; margin: 0.8rem 0 0.4rem 0; padding: 0.2rem 0.6rem; color: var(--text-muted); font-size: 0.78rem; font-weight: 600; user-select: none;">
                            <i class="fa-regular fa-calendar-days" style="margin-right: 5px; color: var(--accent-success);"></i> ${currentDateStr}
                        </div>
                    `;
                }

                const isOut = msg.direction === 'out';
                const bg = isOut
                    ? 'var(--accent-success)'
                    : 'var(--bg-card)';
                const color = isOut ? '#fff' : 'var(--text-main)';
                const align = isOut ? 'flex-end' : 'flex-start';
                const borderRadius = isOut ? '16px 4px 16px 16px' : '4px 16px 16px 16px';
                const border = isOut
                    ? '1px solid rgba(255, 255, 255, 0.18)'
                    : '1px solid var(--border-color)';
                const boxShadow = 'none';

                const timeString = formatChatTime(msg.timestamp);
                const statusIcon = isOut ? renderStatusIcon(msg.status) : '';
                
                let referralHTML = '';
                if (msg.referral) {
                    try {
                        const ref = typeof msg.referral === 'string' ? JSON.parse(msg.referral) : msg.referral;
                        if (ref && (ref.headline || ref.body || ref.image_url)) {
                            referralHTML = `
                                <div style="background: rgba(16,185,129,0.08); border: 1px solid rgba(16,185,129,0.22); border-left: 4px solid var(--accent-success); padding: 0.6rem; margin-bottom: 0.6rem; border-radius: 6px; display: flex; gap: 0.6rem; max-width: 100%; align-items: flex-start; box-sizing: border-box;">
                                    ${ref.image_url ? `<img src="${ref.image_url}" style="width: 55px; height: 55px; object-fit: cover; border-radius: 4px; border: 1px solid var(--border-color); flex-shrink: 0;" />` : ''}
                                    <div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.15rem;">
                                        <div style="font-size: 0.72rem; font-weight: 700; color: var(--accent-success); text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; gap: 0.3rem;">
                                            <i class="fa-brands fa-meta"></i> Anúncio do Instagram/Facebook
                                        </div>
                                        ${ref.headline ? `<div style="font-size: 0.8rem; font-weight: 600; color: var(--text-main); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${ref.headline}</div>` : ''}
                                        ${ref.body ? `<div style="font-size: 0.75rem; color: var(--text-muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.3;">${ref.body}</div>` : ''}
                                    </div>
                                </div>
                            `;
                        }
                    } catch(e) {
                        console.error("Erro ao fazer parse do referral:", e);
                    }
                }

                const isDeleted = msg.message === '🚫 Esta mensagem foi apagada';
                const htmlMsg = isDeleted
                    ? `<span style="font-style: italic; opacity: 0.65; display: flex; align-items: center; gap: 0.4rem; color: var(--text-muted);"><i class="fa-solid fa-ban" style="font-size: 0.85rem;"></i> Esta mensagem foi apagada</span>`
                    : renderChatMessageContent(msg.message);
                
                let quotedHTML = '';
                if (msg.quoted_message) {
                    quotedHTML = renderQuotedMessage(msg.quoted_message, msg.quoted_direction, msg.quoted_id);
                }

                const reactionBadge = reactionsMap[msg.id] ? `
                    <div class="message-reaction-badge" style="
                        position: absolute;
                        bottom: -10px;
                        ${isOut ? 'left: 15px;' : 'right: 15px;'}
                        background: var(--bg-card);
                        border: 1px solid var(--border-color);
                        border-radius: 10px;
                        padding: 0.1rem 0.35rem;
                        font-size: 0.75rem;
                        display: flex;
                        align-items: center;
                        box-shadow: none;
                        user-select: none;
                        z-index: 5;
                    ">
                        ${reactionsMap[msg.id]}
                    </div>
                ` : '';

                html += `
                    <div class="msg-bubble-container" style="display: flex; flex-direction: column; align-items: ${align}; margin-bottom: 0.85rem; position: relative;">
                        <div id="msg-bubble-${msg.id}" style="position: relative; background: ${bg}; color: ${color}; padding: 0.65rem 1rem; border-radius: ${borderRadius}; max-width: 75%; border: ${border}; box-shadow: none; font-size: 0.9rem; line-height: 1.5; transition: background 0.3s ease, box-shadow 0.3s ease, transform 0.3s ease;">
                            <!-- Botão Dropdown de Ações -->
                            ${isDeleted ? '' : `
                            <button class="msg-dropdown-trigger" onclick="toggleMsgDropdown(event, '${msg.id}')" style="
                                position: absolute;
                                top: 5px;
                                right: 5px;
                                background: var(--bg-dark);
                                border: 1px solid var(--border-color);
                                color: var(--text-muted);
                                border-radius: 50%;
                                width: 22px;
                                height: 22px;
                                display: none;
                                align-items: center;
                                justify-content: center;
                                cursor: pointer;
                                z-index: 10;
                                font-size: 0.7rem;
                                box-shadow: none;
                                transition: all 0.2s ease;
                                padding: 0;
                            " onmouseover="this.style.color='var(--accent-success)'; this.style.borderColor='var(--accent-success)'" onmouseout="this.style.color='var(--text-muted)'; this.style.borderColor='var(--border-color)'" title="Opções">
                                <i class="fa-solid fa-chevron-down"></i>
                            </button>
                            `}

                            ${referralHTML}
                            ${quotedHTML}
                            ${htmlMsg}
                            ${reactionBadge}
                        </div>
                        <div style="display: flex; align-items: center; gap: 0.4rem; margin-top: 0.25rem; padding: 0 0.2rem;">
                            <span style="font-size: 0.73rem; color: var(--text-muted);">${timeString}</span>
                            ${statusIcon}
                        </div>
                    </div>
                `;
            });
            const msgsContainer = document.getElementById('chat-active-messages');
            const isScrolledToBottom = msgsContainer.scrollHeight - msgsContainer.clientHeight <= msgsContainer.scrollTop + 50;
            
            // SE ALGUM ÁUDIO OU VÍDEO ESTIVER REPRODUZINDO, NÃO SOBRESCREVA O HTML NO POLLING
            // SILENCIOSO — reconstruir o container reinicia a mídia do zero (efeito de "flick").
            const isAnyMediaPlaying = Array.from(document.querySelectorAll('audio, video')).some(m => !m.paused && !m.ended);
            if (silent && isAnyMediaPlaying) {
                window.lastRenderedMessagesSignature = null; // não marca como "já renderizado" — tenta de novo no próximo poll
                return;
            }

            msgsContainer.innerHTML = html;
            window.lastRenderedMessagesSignature = newMessagesSignature;

            if(!silent || isScrolledToBottom) {
                msgsContainer.scrollTop = msgsContainer.scrollHeight;
            }
            
            if(!silent) loadChats(true);
        }
    } catch(e) {
        if(!silent) document.getElementById('chat-active-messages').innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--accent-danger);">Erro ao carregar mensagens.</div>';
    }
}

window.openAgendarFromChat = function() {
    if (!window.currentActiveChat || !window.currentActiveChat.phone) {
        alert("Nenhum chat ativo no momento.");
        return;
    }
    
    if (typeof leads !== 'undefined' && Array.isArray(leads)) {
        const lead = leads.find(l => isSamePhone(l.telefone, window.currentActiveChat.phone));
        if (lead) {
            // Lead existe no Kanban, abre o modal de agendamento passando o ID dele
            if (typeof openAgendamentoModal === 'function') {
                openAgendamentoModal(lead.id);
            }
        } else {
            // Lead não existe no Kanban (apenas no WhatsApp)
            if (typeof openGridScheduleModal === 'function') {
                // Tenta abrir a modal "vazia" (sem lead preenchido)
                openGridScheduleModal('', '08:00'); 
                
                // Preenche o campo de nome e telefone na modal
                setTimeout(() => {
                    const nameInput = document.getElementById('ag-patient-name');
                    if (nameInput) nameInput.value = window.currentActiveChat.name || '';
                }, 100);
            }
        }
    }
};

function openTemplateModal() {
    if (!window.currentActiveChat) return;
    const modal = document.getElementById('modalSendTemplate');
    if (modal) modal.classList.add('active');
}

async function sendTemplateMessage() {
    if (!window.currentActiveChat || !window.currentActiveChat.phone) return;

    const nameInput = document.getElementById('st-template-name');
    const langSelect = document.getElementById('st-template-lang');
    const templateName = nameInput ? nameInput.value.trim() : '';
    const languageCode = langSelect ? langSelect.value : 'pt_BR';

    if (!templateName) {
        alert('Digite o nome do template aprovado.');
        return;
    }

    const activeLead = typeof leads !== 'undefined'
        ? leads.find(l => isSamePhone(l.telefone, window.currentActiveChat.phone))
        : null;
    if (activeLead && !(await claimLeadConversation(activeLead.id))) return;

    const modal = document.getElementById('modalSendTemplate');

    try {
        const res = await fetch('/api/whatsapp/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                to: window.currentActiveChat.phone,
                isTemplate: true,
                templateName: templateName,
                languageCode: languageCode,
                message: 'template' // Placeholder exigido pelo backend
            })
        });
        const json = await res.json();

        if (json.success) {
            if (modal) modal.classList.remove('active');
            if (nameInput) nameInput.value = '';
            openChat(window.currentActiveChat.phone, window.currentActiveChat.name, true);
        } else {
            alert('Erro ao enviar template: ' + (json.error || 'Desconhecido'));
        }
    } catch (e) {
        alert('Falha na conexão ao enviar template: ' + e.message);
    }
}

async function sendActiveChatMessage() {
    const input = document.getElementById('chat-input-text');
    const rawMsg = input.value.trim();
    if (!rawMsg || !window.currentActiveChat) return;
    if (window.chatLockState && window.chatLockState.locked) {
        alert('Esta conversa está em atendimento por outro atendente. Aguarde ela ficar disponível.');
        return;
    }

    const activeLead = typeof leads !== 'undefined'
        ? leads.find(l => isSamePhone(l.telefone, window.currentActiveChat.phone))
        : null;
    if (activeLead && !(await claimLeadConversation(activeLead.id))) return;

    // Adiciona assinatura automática do atendente — mensagem primeiro, assinatura no final
    let msg = rawMsg;
    if (!rawMsg.startsWith('[FILE:') && !rawMsg.startsWith('[CAPTION:')) {
        msg = appendAttendantSignature(rawMsg);
    }
    
    input.value = '';
    input.style.height = '44px';
    clearChatDraft(window.currentActiveChat.phone);
    if (typeof allChatsList !== 'undefined' && Array.isArray(allChatsList)) {
        filterChatContacts(document.getElementById('chat-search-input') ? document.getElementById('chat-search-input').value : '');
    }

    // Esconde o popup de mensagens rápidas se estiver aberto
    const popup = document.getElementById('quick-replies-popup');
    if (popup) popup.style.display = 'none';

    const msgsContainer = document.getElementById('chat-active-messages');
    const previewHtml = renderChatMessageContent(msg);

    msgsContainer.innerHTML += `
        <div style="display: flex; flex-direction: column; align-items: flex-end; margin-bottom: 0.65rem; opacity: 0.85;">
            <div style="background: #0f766e; border: 1px solid rgba(255, 255, 255, 0.18); color: #ffffff; padding: 0.65rem 1rem; border-radius: 16px 4px 16px 16px; max-width: 75%; box-shadow: none; font-size: 0.9rem; line-height: 1.5;">
                ${previewHtml}
            </div>
            <span style="font-size: 0.73rem; color: var(--text-muted); margin-top: 0.25rem;">Enviando...</span>
        </div>
    `;
    msgsContainer.scrollTop = msgsContainer.scrollHeight;
    
    // ============================================
    // REGRA DE NEGÓCIO:
    // Ao responder a mensagem do lead:
    // 1. Move a coluna para 'Em Atendimento' ('col-contatado') se estiver em 'col-entrada'
    // 2. Atribui a posse da conversa (owner_id/assigned_at) via trava de atendimento
    // ============================================
    if (window.currentActiveChat && window.currentActiveChat.phone && typeof leads !== 'undefined') {
        const phone = window.currentActiveChat.phone;
        const name = window.currentActiveChat.name;

        let lead = leads.find(l => isSamePhone(l.telefone, phone));

        if (lead) {
            if (!lead.column || lead.column === 'col-entrada') {
                lead.column = 'col-contatado';
                if (typeof renderBoard === 'function') renderBoard();
                const statusSelect = document.getElementById('chat-active-status-select');
                if (statusSelect) statusSelect.value = lead.column;

                fetch(`/api/leads/${lead.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ column_id: 'col-contatado' })
                }).catch(console.error);
            }
        } else {
            const newLead = {
                id: Date.now().toString(),
                nome: name && !name.includes('Contato') ? name : 'Lead WhatsApp',
                telefone: phone,
                origem: 'WhatsApp Orgânico',
                column: 'col-contatado',
                owner_id: null
            };
            leads.push(newLead);
            if (typeof renderBoard === 'function') renderBoard();
            const statusSelect = document.getElementById('chat-active-status-select');
            if (statusSelect) statusSelect.value = 'col-contatado';

            if (typeof saveLeadToServer === 'function') {
                saveLeadToServer(newLead).catch(console.error);
            }
        }
    }

    try {
        const quotedId = window.pendingReplyTo ? window.pendingReplyTo.id : undefined;
        cancelReplyTo();

        const res = await fetch('/api/whatsapp/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                to: window.currentActiveChat.phone,
                message: msg,
                isTemplate: false,
                quoted_id: quotedId
            })
        });
        const json = await res.json();
        if(!json.success) {
            alert("Erro ao enviar: " + (json.error || "Desconhecido"));
        }
        openChat(window.currentActiveChat.phone, window.currentActiveChat.name, true);
    } catch(e) {
        alert("Erro na requisição: " + e.message);
    }
}

function openNewMessageModal() {
    document.getElementById('modalNewChat').classList.add('active');
}

function startNewChat() {
    const phoneInput = document.getElementById('ln-lead-phone');
    if(phoneInput) {
        const phone = phoneInput.value.replace(/\D/g, '');
        if(phone.length >= 10) {
            document.getElementById('modalNewChat').classList.remove('active');
            let finalPhone = phone;
            if(!phone.startsWith('55')) finalPhone = '55' + phone;
            openChat(finalPhone, 'Novo Contato');
        } else {
            alert("Digite um telefone válido com DDD");
        }
    }
}

// ============================================
// LÓGICA DE RESPOSTAS RÁPIDAS (QUICK REPLIES `/`)
// ============================================

async function fetchQuickReplies() {
    try {
        const res = await fetch('/api/whatsapp/quick-replies');
        const json = await res.json();
        if (json.success) {
            quickReplies = json.data || [];
        }
    } catch (e) {
        console.error("Erro ao buscar respostas rápidas:", e);
    }
}

function handleQuickReplyInput(e) {
    const val = e.target.value;
    const popup = document.getElementById('quick-replies-popup');
    if (!popup) return;

    if (val.startsWith('/')) {
        const query = val.slice(1).toLowerCase();
        const textMatches = quickReplies.filter(qr =>
            qr.shortcut.toLowerCase().includes(query) ||
            qr.content.toLowerCase().includes(query) ||
            (qr.title && qr.title.toLowerCase().includes(query))
        ).map(qr => ({ kind: 'text', ...qr }));

        // Áudios salvos também aparecem pelo mesmo atalho "/", pesquisando pelo nome —
        // é a "biblioteca facilitada" pedida, unificada com as respostas de texto.
        const audioMatches = (cachedVoiceLibrary || []).filter(a =>
            a.nome.toLowerCase().includes(query)
        ).map(a => ({ kind: 'audio', ...a }));

        const matches = [...textMatches, ...audioMatches];

        if (matches.length > 0) {
            activeQuickReplyIndex = 0;
            renderQuickRepliesPopup(matches);
            popup.style.display = 'block';
        } else {
            popup.style.display = 'none';
        }
    } else {
        popup.style.display = 'none';
    }
}

function handleQuickReplyKeydown(e) {
    const popup = document.getElementById('quick-replies-popup');
    if (!popup || popup.style.display === 'none') return;

    const items = popup.querySelectorAll('.qr-popup-item');
    if (items.length === 0) return;

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeQuickReplyIndex = (activeQuickReplyIndex + 1) % items.length;
        updateActiveQuickReplyItem(items);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeQuickReplyIndex = (activeQuickReplyIndex - 1 + items.length) % items.length;
        updateActiveQuickReplyItem(items);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectQuickReplyByIndex(activeQuickReplyIndex);
    } else if (e.key === 'Escape') {
        popup.style.display = 'none';
    }
}

function updateActiveQuickReplyItem(items) {
    items.forEach((item, idx) => {
        if (idx === activeQuickReplyIndex) {
            item.style.background = 'rgba(16, 185, 129, 0.2)';
            item.style.borderLeft = '3px solid var(--accent-success)';
        } else {
            item.style.background = 'transparent';
            item.style.borderLeft = 'none';
        }
    });
}

let currentQuickReplyMatches = [];

function renderQuickRepliesPopup(matches) {
    const popup = document.getElementById('quick-replies-popup');
    if (!popup) return;

    currentQuickReplyMatches = matches;

    popup.innerHTML = matches.map((item, index) => {
        const activeStyle = index === 0 ? 'background: rgba(16, 185, 129, 0.2); border-left: 3px solid var(--accent-success);' : '';
        if (item.kind === 'audio') {
            return `
        <div class="qr-popup-item" data-index="${index}" onclick="selectQuickReplyByIndex(${index})" style="padding: 0.6rem 1rem; cursor: pointer; border-bottom: 1px solid var(--border-color); ${activeStyle}">
            <div style="display: flex; align-items: center; gap: 0.5rem;">
                <i class="fa-solid fa-microphone" style="color: var(--accent-success); font-size: 0.8rem;"></i>
                <strong style="color: var(--accent-success); font-size: 0.85rem;">${escapeHtml(item.nome)}</strong>
                <span style="font-size: 0.72rem; color: var(--text-muted); margin-left: auto;">Áudio salvo</span>
            </div>
        </div>`;
        }
        return `
        <div class="qr-popup-item" data-index="${index}" onclick="selectQuickReplyByIndex(${index})" style="padding: 0.6rem 1rem; cursor: pointer; border-bottom: 1px solid var(--border-color); ${activeStyle}">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.2rem;">
                <strong style="color: var(--accent-success); font-size: 0.85rem;">/${item.shortcut}</strong>
                <span style="font-size: 0.75rem; color: var(--text-muted);">${item.title || ''}</span>
            </div>
            <div style="font-size: 0.8rem; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 300px;">
                ${item.content}
            </div>
        </div>`;
    }).join('');
}

function selectQuickReplyByIndex(index) {
    const item = currentQuickReplyMatches[index];
    const popup = document.getElementById('quick-replies-popup');
    if (!item) return;

    if (item.kind === 'audio') {
        if (popup) popup.style.display = 'none';
        const input = document.getElementById('chat-input-text');
        if (input) input.value = '';
        sendFromLibrary(item.id, item.nome);
        return;
    }

    const input = document.getElementById('chat-input-text');
    if (input) {
        input.value = item.content;
        input.focus();
    }
    if (popup) popup.style.display = 'none';
}

function openQuickRepliesModal(tab = 'textos') {
    document.getElementById('modalQuickReplies').classList.add('active');
    renderQuickRepliesManagement();
    switchQuickRepliesTab(tab);
}

function closeQuickRepliesModal() {
    document.getElementById('modalQuickReplies').classList.remove('active');
    cancelQuickReplyEdit();
    if (vlRecorder && vlRecorder.state === 'recording') {
        cancelLibraryRecording();
    }
}

function switchQuickRepliesTab(tab) {
    const tabTextos = document.getElementById('qr-tab-textos');
    const tabAudios = document.getElementById('qr-tab-audios');
    const panelTextos = document.getElementById('qr-panel-textos');
    const panelAudios = document.getElementById('qr-panel-audios');

    const isTextos = tab === 'textos';
    if (tabTextos) {
        tabTextos.classList.toggle('active', isTextos);
        tabTextos.style.borderBottom = isTextos ? '2px solid var(--accent-warning)' : '2px solid transparent';
        tabTextos.style.color = isTextos ? 'var(--accent-warning)' : 'var(--text-muted)';
    }
    if (tabAudios) {
        tabAudios.classList.toggle('active', !isTextos);
        tabAudios.style.borderBottom = !isTextos ? '2px solid var(--accent-warning)' : '2px solid transparent';
        tabAudios.style.color = !isTextos ? 'var(--accent-warning)' : 'var(--text-muted)';
    }
    if (panelTextos) panelTextos.style.display = isTextos ? 'flex' : 'none';
    if (panelAudios) panelAudios.style.display = isTextos ? 'none' : 'flex';

    if (!isTextos) loadVoiceLibrary();
}

function renderQuickRepliesManagement() {
    const listEl = document.getElementById('quick-replies-list');
    if (!listEl) return;

    if (quickReplies.length === 0) {
        listEl.innerHTML = '<div style="padding: 1.5rem; text-align: center; color: var(--text-muted);">Nenhuma resposta rápida cadastrada.</div>';
        return;
    }

    listEl.innerHTML = quickReplies.map(qr => `
        <div style="padding: 0.8rem 1rem; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center;">
            <div style="flex: 1; margin-right: 1rem;">
                <div style="display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.3rem;">
                    <strong style="color: var(--accent-success); font-size: 0.9rem;">/${qr.shortcut}</strong>
                    <span style="font-weight: 600; color: var(--text-main); font-size: 0.85rem;">${qr.title || ''}</span>
                </div>
                <div style="font-size: 0.85rem; color: var(--text-muted); white-space: pre-wrap;">${qr.content}</div>
            </div>
            <div style="display: flex; gap: 0.4rem;">
                <button class="btn-secondary" onclick="editQuickReply('${qr.shortcut}')" title="Editar" style="padding: 0.4rem 0.6rem;"><i class="fa-solid fa-pen"></i></button>
                <button class="btn-cancel" onclick="deleteQuickReply('${qr.shortcut}')" title="Excluir" style="padding: 0.4rem 0.6rem;"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>
    `).join('');
}

async function saveQuickReply() {
    const shortcutInput = document.getElementById('qr-shortcut');
    const titleInput = document.getElementById('qr-title');
    const contentInput = document.getElementById('qr-content');

    const shortcut = shortcutInput.value.trim().replace(/^\//, '');
    const title = titleInput.value.trim();
    const content = contentInput.value.trim();

    if (!shortcut || !content) {
        alert("Preencha pelo menos o atalho (ex: ola) e o conteúdo da mensagem.");
        return;
    }

    try {
        const res = await fetch('/api/whatsapp/quick-replies', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shortcut, title, text: content, original_shortcut: editingQuickReplyShortcut })
        });
        const json = await res.json();
        if (json.success) {
            await fetchQuickReplies();
            renderQuickRepliesManagement();
            shortcutInput.value = '';
            titleInput.value = '';
            contentInput.value = '';
            cancelQuickReplyEdit();
        } else {
            alert("Erro ao salvar: " + (json.error || 'Erro desconhecido'));
        }
    } catch (e) {
        alert("Erro na requisição: " + e.message);
    }
}

function editQuickReply(shortcut) {
    const qr = quickReplies.find(r => r.shortcut.toLowerCase() === shortcut.toLowerCase());
    if (!qr) return;

    editingQuickReplyShortcut = qr.shortcut;
    document.getElementById('qr-shortcut').value = qr.shortcut;
    document.getElementById('qr-title').value = qr.title || '';
    document.getElementById('qr-content').value = qr.content || '';
    document.getElementById('qr-cancel-edit-btn').style.display = 'inline-block';
}

function cancelQuickReplyEdit() {
    editingQuickReplyShortcut = null;
    document.getElementById('qr-shortcut').value = '';
    document.getElementById('qr-title').value = '';
    document.getElementById('qr-content').value = '';
    const cancelBtn = document.getElementById('qr-cancel-edit-btn');
    if (cancelBtn) cancelBtn.style.display = 'none';
}

async function deleteQuickReply(shortcut) {
    if (!await customConfirm(`Deseja realmente excluir a resposta rápida /${shortcut}?`, 'Excluir Resposta Rápida')) return;

    try {
        const res = await fetch(`/api/whatsapp/quick-replies?shortcut=${encodeURIComponent(shortcut)}`, {
            method: 'DELETE'
        });
        const json = await res.json();
        if (json.success) {
            await fetchQuickReplies();
            renderQuickRepliesManagement();
        } else {
            alert("Erro ao excluir: " + (json.error || 'Erro desconhecido'));
        }
    } catch (e) {
        alert("Erro na requisição: " + e.message);
    }
}

// Inicializa no carregamento
window.addEventListener('DOMContentLoaded', () => {
    fetchQuickReplies();
    loadVoiceLibrary();
    loadChatSettings();
    const chatInput = document.getElementById('chat-input-text');
    if (chatInput) {
        chatInput.addEventListener('input', handleQuickReplyInput);
        chatInput.addEventListener('keydown', handleQuickReplyKeydown);
    }
});

// Polling global em segundo plano a cada 6s para som de notificação e bolinha verde
if (!window.globalChatCheckInterval) {
    window.globalChatCheckInterval = setInterval(() => {
        if (typeof loadChats === 'function') loadChats(true);
        if (window.currentActiveChat && document.getElementById('view-chat') && document.getElementById('view-chat').style.display !== 'none') {
            if (typeof openChat === 'function') openChat(window.currentActiveChat.phone, window.currentActiveChat.name, true);
        }
    }, 6000);
}
