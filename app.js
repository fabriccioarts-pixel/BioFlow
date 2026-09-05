// === THEME MANAGER ===
function initTheme() {
    const savedTheme = localStorage.getItem('crm_theme') || 'dark';
    if (savedTheme === 'light') {
        document.body.setAttribute('data-theme', 'light');
        const icon = document.querySelector('#theme-toggle i');
        if (icon) { icon.classList.remove('fa-moon'); icon.classList.add('fa-sun'); }
    }
}
initTheme();

// === LOADER PADRÃO — "morphing infinity" ===
// Todo lugar do app usa <span class="amicro-loader">…</span>. Em vez de editar
// dezenas de call sites, este shim troca o conteúdo pelo SVG do infinito
// (e cobre loaders inseridos dinamicamente via MutationObserver).
(function () {
    var MI_PATH = 'M20,30 C20,7 43,7 50,30 C57,53 80,53 80,30 C80,7 57,7 50,30 C43,53 20,53 20,30 Z';
    var MI_SVG =
        '<svg class="mi-svg" viewBox="0 0 100 60" fill="none" aria-hidden="true">' +
        '<path class="mi-track" d="' + MI_PATH + '"/>' +
        '<path class="mi-head" pathLength="100" d="' + MI_PATH + '"/></svg>';

    function upgrade(el) {
        if (!el || el.dataset.mi) return;
        el.dataset.mi = '1';
        el.innerHTML = MI_SVG;
        // Garante o pathLength mesmo se o parser de innerHTML não preservar o atributo.
        var head = el.querySelector('.mi-head');
        if (head) head.setAttribute('pathLength', '100');
    }
    function scan(node) {
        if (node.nodeType !== 1) return;
        if (node.classList && node.classList.contains('amicro-loader')) upgrade(node);
        if (node.querySelectorAll) node.querySelectorAll('.amicro-loader').forEach(upgrade);
    }

    scan(document.documentElement);
    document.addEventListener('DOMContentLoaded', function () { scan(document.documentElement); });
    new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
            var added = muts[i].addedNodes;
            for (var j = 0; j < added.length; j++) scan(added[j]);
        }
    }).observe(document.documentElement, { childList: true, subtree: true });
})();

// === SESSÃO EXPIRADA — interceptação global de 401 ===
// O cookie de sessão (JWT) vale 12h, mas o "estou logado" do front vem do
// localStorage, que não expira. Quando o cookie some, todo /api passa a
// responder 401 e os loaders engoliam o erro em silêncio — a interface ficava
// "logada" e sem dados, e só deslogar/logar resolvia. Aqui a gente detecta
// qualquer 401 vindo de uma rota /api e reabre a tela de login.
(function () {
    const _origFetch = window.fetch.bind(window);

    function reqUrl(input) {
        try {
            const raw = typeof input === 'string' ? input : (input && input.url) || '';
            if (!raw) return null;
            return new URL(raw, window.location.origin);
        } catch (e) { return null; }
    }
    function isApiUrl(input) {
        const u = reqUrl(input);
        return !!u && u.origin === window.location.origin && u.pathname.startsWith('/api/');
    }
    function isAuthEndpoint(input) {
        const u = reqUrl(input);
        return !!u && /^\/api\/(login|logout)\b/.test(u.pathname);
    }

    window.handleSessionExpired = function () {
        if (window.__authExpiredShown) return;
        window.__authExpiredShown = true;

        // Para todo polling de fundo pra não martelar o servidor com 401 em loop.
        ['kanbanSyncInterval', 'heartbeatInterval', 'dashPollingInterval',
         'chatPollingInterval', 'globalChatCheckInterval', 'notifPollInterval'
        ].forEach(k => { if (window[k]) { clearInterval(window[k]); window[k] = null; } });
        if (window._kanbanSSE) { try { window._kanbanSSE.close(); } catch (e) {} window._kanbanSSE = null; }

        localStorage.removeItem('crm_user');
        try { loggedUser = null; } catch (e) {}

        const overlay = document.getElementById('login-overlay');
        if (!overlay) {
            // Páginas auxiliares (agenda.html etc.) não têm o overlay: volta pro index.
            const p = window.location.pathname;
            if (!p.endsWith('index.html') && p !== '/' && p !== '') window.location.href = 'index.html';
            return;
        }
        overlay.classList.add('active');
        const fields = document.getElementById('login-fields');
        const force = document.getElementById('force-change-fields');
        if (fields) fields.style.display = 'flex';
        if (force) force.style.display = 'none';
        const badge = document.getElementById('login-error-badge');
        const badgeText = document.getElementById('login-error-text');
        if (badge && badgeText) {
            badgeText.textContent = 'Sua sessão expirou. Entre novamente.';
            badge.style.display = 'flex';
        }
    };

    window.fetch = async function (input, init) {
        const res = await _origFetch(input, init);
        if (res.status === 401 && isApiUrl(input) && !isAuthEndpoint(input)) {
            window.handleSessionExpired();
        }
        return res;
    };
})();

// === DADOS DO KANBAN (LOCAL) ===
let leads = [];
let loggedUser = JSON.parse(localStorage.getItem('crm_user'));
// Declarados logo no topo (usados em renderBoard/resolveDisplayName, chamados
// bem antes de onde esse bloco costumava ficar) pra nunca cair em Temporal
// Dead Zone se algo disparar um render mais cedo do que o esperado.
let displayNamesMap = {};
let avatarMap = {};

// Escapa texto antes de inserir em innerHTML — usado em qualquer campo que pode
// vir de fora (nome/origem de lead criado via webhook do WhatsApp, nome de paciente etc.)
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function parseSqlDate(dateStr) {
    if (!dateStr) return null;
    let isoStr = dateStr.replace(' ', 'T');
    // Sem marcador de fuso? Trata como UTC. (O guard antigo checava !includes('-'),
    // mas os hifens da própria data faziam ele nunca adicionar o Z.)
    if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(isoStr)) {
        isoStr += 'Z';
    }
    const d = new Date(isoStr);
    if (!isNaN(d.getTime())) return d;
    const parts = dateStr.split(/[- :]/);
    if (parts.length >= 3) {
        const year = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1;
        const day = parseInt(parts[2], 10);
        const hour = parts[3] ? parseInt(parts[3], 10) : 0;
        const minute = parts[4] ? parseInt(parts[4], 10) : 0;
        const second = parts[5] ? parseInt(parts[5], 10) : 0;
        return new Date(Date.UTC(year, month, day, hour, minute, second));
    }
    return null;
}

// Listas de Opções do Amigo App
let apiOptions = { places: [], doctors: [], events: [] };

// ── Agenda: profissionais (colunas) ─────────────────────────────────
// A API só devolve como coluna quem tem agendamento no dia (ou o que veio em
// /doctors, que às vezes vem incompleto). Guardamos a união de todo profissional
// já visto — em qualquer dia ou nas opções — pra que as colunas fiquem estáveis
// e o filtro liste todo mundo, mesmo sem agendamento no dia aberto.
// "Horário" é o rótulo da coluna de horas — nunca um profissional. Já entrou
// como coluna-fantasma no localStorage por um bug antigo; filtramos aqui e
// reescrevemos a lista, pra se auto-corrigir.
function isAgendaPhantomDoctor(name) {
    return /^\s*hor[áa]rio\s*$/i.test(String(name || ''));
}
let agendaKnownDoctors = new Map();
try {
    let _dirty = false;
    JSON.parse(localStorage.getItem('agendaKnownDoctors') || '[]')
        .forEach(d => {
            if (!d || d.id == null) return;
            if (isAgendaPhantomDoctor(d.name)) { _dirty = true; return; }
            agendaKnownDoctors.set(String(d.id), { id: d.id, name: d.name || 'Sem nome' });
        });
    if (_dirty) localStorage.setItem('agendaKnownDoctors', JSON.stringify([...agendaKnownDoctors.values()]));
} catch (e) {}

// IDs de profissionais ocultados no filtro da agenda.
let agendaHiddenProfs = new Set();
try {
    JSON.parse(localStorage.getItem('agendaHiddenProfs') || '[]').forEach(id => agendaHiddenProfs.add(String(id)));
} catch (e) {}

let _agendaOptionsKicked = false;

function agendaRememberDoctors(list) {
    let changed = false;
    (list || []).forEach(d => {
        if (!d || d.id == null || d.id === 0) return;
        if (isAgendaPhantomDoctor(d.name)) return;
        const key = String(d.id);
        const prev = agendaKnownDoctors.get(key);
        if (!prev || (d.name && d.name !== prev.name)) {
            agendaKnownDoctors.set(key, { id: d.id, name: d.name || (prev && prev.name) || 'Sem nome' });
            changed = true;
        }
    });
    if (changed) {
        try { localStorage.setItem('agendaKnownDoctors', JSON.stringify([...agendaKnownDoctors.values()])); } catch (e) {}
    }
}

function agendaPersistHidden() {
    try { localStorage.setItem('agendaHiddenProfs', JSON.stringify([...agendaHiddenProfs])); } catch (e) {}
}

function toggleAgendaProf(id, show) {
    const key = String(id);
    if (show) agendaHiddenProfs.delete(key);
    else agendaHiddenProfs.add(key);
    agendaPersistHidden();
    renderAgendaGrid();
}

function agendaProfSetAll(show) {
    if (show) {
        agendaHiddenProfs.clear();
    } else {
        agendaHiddenProfs = new Set([...agendaKnownDoctors.keys()]);
    }
    agendaPersistHidden();
    renderAgendaGrid();
}

// Cria (uma vez) o botão + painel do filtro de profissionais na barra da agenda.
function ensureAgendaProfFilterUI() {
    if (document.getElementById('agenda-prof-filter')) return;
    const bar = document.querySelector('#view-agenda .agenda-actions') || document.querySelector('#view-agenda .agenda-filters');
    if (!bar) return;

    const wrap = document.createElement('div');
    wrap.id = 'agenda-prof-filter';
    wrap.className = 'agenda-prof-filter';
    wrap.innerHTML = `
        <button type="button" class="btn-secondary agenda-prof-btn" onclick="toggleAgendaProfPanel(event)">
            <i class="fa-solid fa-user-doctor"></i>
            <span>Profissionais</span>
            <span class="agenda-prof-count" id="agenda-prof-count"></span>
            <i class="fa-solid fa-chevron-down" style="font-size: 0.7rem;"></i>
        </button>
        <div class="agenda-prof-panel" id="agenda-prof-panel" style="display: none;">
            <div class="agenda-prof-panel-actions">
                <button type="button" onclick="agendaProfSetAll(true)">Marcar todos</button>
                <button type="button" onclick="agendaProfSetAll(false)">Limpar</button>
            </div>
            <div class="agenda-prof-list" id="agenda-prof-list"></div>
        </div>`;
    bar.appendChild(wrap);

    document.addEventListener('click', (e) => {
        if (!wrap.contains(e.target)) {
            const p = document.getElementById('agenda-prof-panel');
            if (p) p.style.display = 'none';
        }
    });
}

function toggleAgendaProfPanel(ev) {
    if (ev) ev.stopPropagation();
    const p = document.getElementById('agenda-prof-panel');
    if (p) p.style.display = p.style.display === 'none' ? 'block' : 'none';
}

// Popula a lista de checkboxes do filtro a partir de agendaKnownDoctors.
function renderAgendaProfFilter(allDoctors) {
    ensureAgendaProfFilterUI();
    const list = document.getElementById('agenda-prof-list');
    const countEl = document.getElementById('agenda-prof-count');
    if (!list) return;

    const ordered = [...allDoctors].sort((a, b) => a.name.localeCompare(b.name));
    list.innerHTML = ordered.map(d => {
        const key = String(d.id);
        const checked = !agendaHiddenProfs.has(key) ? 'checked' : '';
        return `<label class="agenda-prof-item">
            <input type="checkbox" ${checked} onchange="toggleAgendaProf('${key.replace(/'/g, "\\'")}', this.checked)">
            <span>${escapeHtml(d.name)}</span>
        </label>`;
    }).join('') || '<div class="agenda-prof-empty">Nenhum profissional carregado ainda.</div>';

    const total = ordered.length;
    const visiveis = ordered.filter(d => !agendaHiddenProfs.has(String(d.id))).length;
    if (countEl) {
        if (total && visiveis < total) {
            countEl.textContent = `${visiveis}/${total}`;
            countEl.style.display = '';
        } else {
            countEl.textContent = '';
            countEl.style.display = 'none';
        }
    }
}

function initApp() {
    initTheme();
    if (loggedUser) {
        const overlay = document.getElementById('login-overlay');
            if(overlay) overlay.classList.remove('active');
        
        // Etiquetas precisam estar carregadas antes do primeiro renderBoard() pra não
        // desenhar os cards sem badge na primeira renderização.
        if (typeof loadAvailableTags === 'function') {
            loadAvailableTags().then(() => fetchLeadsFromServer());
        } else {
            fetchLeadsFromServer(); // Busca na nuvem e renderiza todos os leads compartilhados
        }
        fetchApiOptions();
        startNotificationPolling();
        loadAudiences();

        // SSE para sincronização instantânea; polling só como rede de segurança
        // (SSE cobre o tempo real, então esse intervalo pode ser bem largo — é
        // só pra cobrir alguma desconexão de SSE não percebida).
        initKanbanSSE();
        if (!window.kanbanSyncInterval) {
            window.kanbanSyncInterval = setInterval(() => {
                if (loggedUser) fetchLeadsFromServer(true);
            }, 90000);
        }
        
        if (loggedUser.role === 'admin' || loggedUser.username === 'admin') {
            const btnGestao = document.getElementById('flyout-gestao-acessos');
            if (btnGestao) {
                btnGestao.style.display = 'flex';
            }
            const btnAiAgent = document.getElementById('sb-tool-ai-agent');
            if (btnAiAgent) {
                btnAiAgent.style.display = 'flex';
            }
        }

        updateHeaderProfileUI();
        loadDisplayNamesMap();
        loadUnidades();
        startHeartbeat();

        // Continuação da busca global de paciente: se veio de outra página (ex: Histórico)
        // pedindo pra abrir uma conversa específica, abre assim que o chat estiver disponível.
        const deepLinkParams = new URLSearchParams(window.location.search);
        const openChatPhone = deepLinkParams.get('open_chat');
        if (openChatPhone && typeof openChat === 'function') {
            const openChatName = deepLinkParams.get('open_name') || '';
            switchTab('chat');
            openChat(openChatPhone, openChatName);
            const cleanUrl = window.location.pathname;
            window.history.replaceState({}, document.title, cleanUrl);
        }
    } else {
        const overlay = document.getElementById('login-overlay');
        if (overlay) {
            overlay.classList.add('active');
        } else {
            const currentPath = window.location.pathname;
            if (!currentPath.includes('index.html') && currentPath !== '/' && currentPath !== '') {
                window.location.href = 'index.html';
            }
        }
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}

// Chuva de confete comemorando um agendamento novo. Canvas próprio, sem
// biblioteca externa, some sozinho ao fim da animação.
function celebrateAgendamento() {
    try {

        const canvas = document.createElement('canvas');
        canvas.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:99999999;';
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        document.body.appendChild(canvas);
        const ctx = canvas.getContext('2d');

        const colors = ['#10b981', '#34d399', '#2dd4bf', '#fbbf24', '#60a5fa', '#f87171'];
        const gravity = 0.22;
        const dragFactor = 0.0025;
        const particleCount = 160;
        const particles = [];

        for (let i = 0; i < particleCount; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 6 + Math.random() * 10;
            particles.push({
                x: canvas.width / 2 + (Math.random() - 0.5) * 140,
                y: canvas.height * 0.35,
                vx: Math.cos(angle) * speed * (0.4 + Math.random() * 0.6),
                vy: Math.sin(angle) * speed - 6,
                size: 5 + Math.random() * 5,
                color: colors[Math.floor(Math.random() * colors.length)],
                rotation: Math.random() * 360,
                spin: (Math.random() - 0.5) * 16,
                shape: Math.random() < 0.5 ? 'rect' : 'circle',
                opacity: 1
            });
        }

        const start = performance.now();
        const duration = 2600;
        const fadeStart = duration * 0.6;

        function frame(now) {
            const elapsed = now - start;
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            particles.forEach(p => {
                p.vy += gravity;
                p.vx *= (1 - dragFactor);
                p.x += p.vx;
                p.y += p.vy;
                p.rotation += p.spin;
                if (elapsed > fadeStart) {
                    p.opacity = Math.max(0, 1 - (elapsed - fadeStart) / (duration - fadeStart));
                }

                ctx.save();
                ctx.translate(p.x, p.y);
                ctx.rotate(p.rotation * Math.PI / 180);
                ctx.globalAlpha = p.opacity;
                ctx.fillStyle = p.color;
                if (p.shape === 'rect') {
                    ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.6);
                } else {
                    ctx.beginPath();
                    ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
            });

            if (elapsed < duration) {
                requestAnimationFrame(frame);
            } else {
                canvas.remove();
            }
        }
        requestAnimationFrame(frame);
    } catch (e) {
        console.error('Erro ao exibir confete:', e);
    }
}

function toggleTheme() {
    const currentTheme = document.body.getAttribute('data-theme');
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    
    document.body.setAttribute('data-theme', newTheme);
    localStorage.setItem('crm_theme', newTheme);
    
    const icon = document.querySelector('#theme-toggle i');
    if (icon) {
        if (newTheme === 'light') {
            icon.classList.remove('fa-moon');
            icon.classList.add('fa-sun');
        } else {
            icon.classList.remove('fa-sun');
            icon.classList.add('fa-moon');
        }
    }
}
// === KANBAN SSE — sincronização em tempo real ===
function initKanbanSSE() {
    if (window._kanbanSSE) return;
    const es = new EventSource('/api/kanban/events');
    window._kanbanSSE = es;

    es.onmessage = (e) => {
        try {
            const { action, leadId, phone, preview, msg_ts } = JSON.parse(e.data);
            if (loggedUser && ['created', 'updated', 'deleted'].includes(action)) {
                fetchLeadsFromServer(true);
            }
            // Alguém entrou/saiu de uma conversa — atualiza os avatares nos cards do chat na hora.
            if (action === 'presence' && typeof refreshChatPresence === 'function') {
                refreshChatPresence();
            }
            // Mensagem nova no WhatsApp — chega na hora por SSE (sobrevive à aba em
            // segundo plano, ao contrário do polling, que fica pausado nesse caso).
            if (action === 'wa_message') {
                const jaAberta = window.currentActiveChat && typeof isSamePhone === 'function'
                    && phone && isSamePhone(window.currentActiveChat.phone, phone);
                // Remenda a lista LOCALMENTE (topo, prévia, não-lidas) — sem refazer a
                // consulta cara. A reconciliação com o servidor vem no poll de 90s.
                if (typeof patchChatListFromSSE === 'function') {
                    try { patchChatListFromSSE({ phone, preview, ts: msg_ts, leadId }); } catch (_) {}
                }
                if (!jaAberta && typeof playNotificationSound === 'function') {
                    try { playNotificationSound(); } catch (_) {}
                }
                // Se a conversa está aberta na tela, atualiza ela também (barato: filtra por telefone).
                if (jaAberta && typeof openChat === 'function') {
                    openChat(window.currentActiveChat.phone, window.currentActiveChat.name, true);
                }
            }
        } catch (_) {}
    };

    es.onerror = () => {
        es.close();
        window._kanbanSSE = null;
        setTimeout(initKanbanSSE, 10000);
    };
}

// === CONEXÃO COM O BANCO DE DADOS ===
async function fetchLeadsFromServer(silent = false) {
    try {
        // Kanban 100% compartilhado e sincronizado entre todos os atendentes
        const res = await fetch('/api/leads');
        const rows = await res.json();
        const newLeads = (rows || []).map(r => {
            const column = r.column_id || 'col-entrada';
            // Mantém a coluna local se esse lead tem um PUT de mudança de coluna ainda em
            // andamento — essa resposta do GET pode ter sido disparada antes do drag-and-drop
            // e chegar depois, com dado desatualizado.
            const pending = pendingColumnUpdates[r.id];
            return { ...r, column: pending !== undefined ? pending : column };
        });

        if (silent && JSON.stringify(leads) === JSON.stringify(newLeads)) {
            return;
        }

        leads = newLeads;
        renderBoard();
        if (typeof renderHotLeadsBadge === 'function') renderHotLeadsBadge();
    } catch (e) {
        if (!silent) {
            console.error('Erro ao buscar leads:', e);
            renderBoard();
        }
    }
}

async function saveLeadToServer(lead) {
    try {
        // Renomear column para column_id e incluir owner_id
        const payload = { ...lead, column_id: lead.column, owner_id: loggedUser ? loggedUser.username : null };
        const res = await fetch('/api/leads', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const json = await res.json();
        if (json.error) console.error(json.error);

        // O servidor recusa duplicar lead pro mesmo telefone e devolve o id do lead já
        // existente — adota esse id localmente pra não ficar com um card "órfão" (PUTs
        // indo pra um id que não existe de fato no banco).
        if (json.duplicate && json.id && json.id !== lead.id) {
            lead.id = json.id;
            if (typeof renderBoard === 'function') renderBoard();
        }
    } catch (e) {
        console.error('Erro ao salvar lead no servidor', e);
    }
}

// Colunas com PUT em andamento — o polling do Kanban (a cada 5s) busca o board
// inteiro do servidor e substitui o array "leads" local. Sem essa proteção, uma
// requisição de polling que já estava em voo antes do drag-and-drop podia responder
// logo depois com a coluna antiga e "devolver" o card pro lugar de onde ele saiu.
const pendingColumnUpdates = {};

async function updateLeadColumnOnServer(id, column) {
    pendingColumnUpdates[id] = column;
    try {
        const res = await fetch(`/api/leads/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ column_id: column })
        });
        const json = await res.json();
        if (json.error) console.error(json.error);
    } catch (e) {
        console.error('Erro ao mover lead no servidor', e);
    } finally {
        // Só libera se ninguém arrastou o mesmo card de novo enquanto esse PUT rodava.
        if (pendingColumnUpdates[id] === column) delete pendingColumnUpdates[id];
    }
}

async function fetchApiOptions() {
    try {
        const unidadeId = typeof getSelectedUnidadeId === 'function' ? getSelectedUnidadeId() : '';
        const response = await fetch(`/api/options${unidadeId ? `?unidade_id=${encodeURIComponent(unidadeId)}` : ''}`);
        if(response.ok) {
            apiOptions = await response.json();
            populateSelects();
            if (typeof renderAgendaGrid === 'function') {
                renderAgendaGrid();
            }
        }
    } catch(e) {
        console.error("Erro ao buscar opções da API", e);
    }
}

function populateSelects() {
    const placeSelect = document.getElementById('ag-place');
    const userSelect = document.getElementById('ag-user');
    
    if(!placeSelect) return;
    
    placeSelect.innerHTML = '<option value="">Selecione...</option>' + 
        apiOptions.places.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
        
    userSelect.innerHTML = '<option value="">Selecione...</option>' + 
        apiOptions.doctors.map(d => `<option value="${d.id}">${d.name}</option>`).join('');
        
    // Configurando Dropdown Pesquisável para Procedimentos
    const eventSearch = document.getElementById('ag-event-search');
    const eventDropdown = document.getElementById('ag-event-dropdown');
    const eventHidden = document.getElementById('ag-event');
    
    if (eventSearch && eventDropdown) {
        eventDropdown.innerHTML = apiOptions.events.map(e => 
            `<div class="ag-dropdown-item" data-id="${e.id}" data-name="${e.name}">${e.name}</div>`
        ).join('');
        
        eventSearch.addEventListener('focus', () => {
            eventDropdown.style.display = 'block';
            eventSearch.select();
        });
        
        eventSearch.addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            eventDropdown.style.display = 'block';
            eventDropdown.querySelectorAll('.ag-dropdown-item').forEach(item => {
                const name = item.dataset.name.toLowerCase();
                item.style.display = name.includes(term) ? 'block' : 'none';
            });
        });
        
        document.addEventListener('click', (e) => {
            if (!eventSearch.contains(e.target) && !eventDropdown.contains(e.target)) {
                eventDropdown.style.display = 'none';
            }
        });
        
        eventDropdown.addEventListener('click', (e) => {
            if (e.target.classList.contains('ag-dropdown-item')) {
                eventHidden.value = e.target.dataset.id;
                eventSearch.value = e.target.dataset.name;
                eventDropdown.style.display = 'none';
            }
        });
    }

    // Configurando Dropdown Pesquisável para Procedimento de Interesse (Orçamento) —
    // mesmo padrão visual/comportamento do dropdown de procedimento da Agenda, em vez do
    // <datalist> nativo (que o navegador desenha sozinho, sem herdar o estilo do sistema).
    const orcSearch = document.getElementById('orc-procedimento');
    const orcDropdown = document.getElementById('orc-procedimento-dropdown');

    if (orcSearch && orcDropdown) {
        orcDropdown.innerHTML = apiOptions.events.map(e =>
            `<div class="ag-dropdown-item" data-name="${e.name}">${e.name}</div>`
        ).join('');

        orcSearch.addEventListener('focus', () => {
            orcDropdown.style.display = 'block';
        });

        orcSearch.addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            orcDropdown.style.display = 'block';
            orcDropdown.querySelectorAll('.ag-dropdown-item').forEach(item => {
                const name = item.dataset.name.toLowerCase();
                item.style.display = name.includes(term) ? 'block' : 'none';
            });
        });

        document.addEventListener('click', (e) => {
            if (!orcSearch.contains(e.target) && !orcDropdown.contains(e.target)) {
                orcDropdown.style.display = 'none';
            }
        });

        orcDropdown.addEventListener('click', (e) => {
            if (e.target.classList.contains('ag-dropdown-item')) {
                orcSearch.value = e.target.dataset.name;
                orcDropdown.style.display = 'none';
            }
        });
    }
}

// === RENDERIZAÇÃO DO KANBAN ===
function clearKanbanFilters() {
    const ids = ['filter-search', 'filter-owner', 'filter-origem', 'filter-date-start', 'filter-date-end'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const chk = document.getElementById('filter-has-schedule');
    if (chk) chk.checked = false;
    renderBoard();
}

// === PÚBLICOS SALVOS (recortes de leads por filtro, reaproveitados na campanha) ===
let cachedAudiences = [];

async function loadAudiences() {
    try {
        const res = await fetch('/api/audiences');
        const json = await res.json();
        cachedAudiences = json.data || [];
    } catch (e) {
        console.error('Erro ao carregar públicos salvos:', e);
    }
    populateKanbanAudienceSelect();
    populateCampaignAudienceOptions();
}

function populateKanbanAudienceSelect() {
    const sel = document.getElementById('kanban-audience-select');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">🎯 Públicos Salvos</option>' +
        cachedAudiences.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
    if (cachedAudiences.some(a => a.id === current)) sel.value = current;
}

function populateCampaignAudienceOptions() {
    const optgroup = document.getElementById('campaign-audience-optgroup');
    if (!optgroup) return;
    const targetSelect = document.getElementById('campaign-target');
    const current = targetSelect ? targetSelect.value : '';

    if (cachedAudiences.length === 0) {
        optgroup.style.display = 'none';
        optgroup.innerHTML = '';
        return;
    }
    optgroup.style.display = '';
    optgroup.innerHTML = cachedAudiences.map(a => `<option value="audience:${a.id}">${escapeHtml(a.name)}</option>`).join('');
    if (targetSelect && current) targetSelect.value = current;
}

async function saveCurrentFiltersAsAudience() {
    const name = prompt('Nome do público (ex: "Entrada Ago/2026", "Leads da Carol - período"):');
    if (!name || !name.trim()) return;

    const payload = {
        name: name.trim(),
        owner_id: document.getElementById('filter-owner')?.value || '',
        origem: document.getElementById('filter-origem')?.value || '',
        date_start: document.getElementById('filter-date-start')?.value || '',
        date_end: document.getElementById('filter-date-end')?.value || '',
        has_schedule: document.getElementById('filter-has-schedule')?.checked ? 1 : 0
    };

    if (!payload.owner_id && !payload.origem && !payload.date_start && !payload.date_end && !payload.has_schedule) {
        if (!confirm('Nenhum filtro está ativo agora — esse público vai representar TODOS os leads. Continuar?')) return;
    }

    try {
        const res = await fetch('/api/audiences', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Erro ao salvar público');
        if (typeof showToast === 'function') showToast(`Público "${payload.name}" salvo!`, 'success');
        await loadAudiences();
    } catch (e) {
        alert(e.message);
    }
}

function applyAudienceToKanbanFilters(audienceId) {
    if (!audienceId) return;
    const audience = cachedAudiences.find(a => a.id === audienceId);
    if (!audience) return;

    const ownerEl = document.getElementById('filter-owner');
    const origemEl = document.getElementById('filter-origem');
    const dateStartEl = document.getElementById('filter-date-start');
    const dateEndEl = document.getElementById('filter-date-end');
    const scheduleEl = document.getElementById('filter-has-schedule');

    if (ownerEl) ownerEl.value = audience.owner_id || '';
    if (origemEl) origemEl.value = audience.origem || '';
    if (dateStartEl) dateStartEl.value = audience.date_start || '';
    if (dateEndEl) dateEndEl.value = audience.date_end || '';
    if (scheduleEl) scheduleEl.checked = Number(audience.has_schedule) === 1;

    renderBoard();
}

async function deleteSelectedAudience() {
    const sel = document.getElementById('kanban-audience-select');
    const audienceId = sel ? sel.value : '';
    if (!audienceId) {
        alert('Selecione um público na lista pra apagar.');
        return;
    }
    const audience = cachedAudiences.find(a => a.id === audienceId);
    if (!await customConfirm(`Apagar o público "${audience ? audience.name : ''}"? Isso não afeta os leads, só o filtro salvo.`, 'Apagar Público')) return;

    try {
        const res = await fetch(`/api/audiences/${audienceId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json()).error || 'Erro ao apagar público');
        if (typeof showToast === 'function') showToast('Público apagado.', 'success');
        await loadAudiences();
    } catch (e) {
        alert(e.message);
    }
}

// Mesma lógica de filtro do renderBoard() do Kanban, reaplicada em cima de um
// Público salvo — usada pelo disparo de campanha (getEligibleCampaignLeads).
function filterLeadsByAudience(audience) {
    return leads.filter(lead => {
        if (audience.owner_id && lead.owner_id !== audience.owner_id) return false;
        if (audience.origem && lead.origem !== audience.origem) return false;
        if (Number(audience.has_schedule) === 1 && lead.column !== 'col-agendado' && !lead.agendamento) return false;
        if (audience.date_start || audience.date_end) {
            const rawDate = lead.created_at || '';
            const leadDate = rawDate.includes('T') ? rawDate.split('T')[0] : rawDate.split(' ')[0];
            if (!leadDate) return false;
            if (audience.date_start && leadDate < audience.date_start) return false;
            if (audience.date_end && leadDate > audience.date_end) return false;
        }
        return true;
    });
}

// Badge no menu lateral ("CRM Vendas") com a quantidade de leads novos aguardando
// na coluna Entrada — mesmo visual do badge de mensagens não lidas do chat.
function updateKanbanEntradaBadge() {
    const badge = document.getElementById('kanban-entrada-badge');
    if (!badge) return;
    const count = (typeof leads !== 'undefined' && Array.isArray(leads))
        ? leads.filter(l => !l.column || l.column === 'col-entrada').length
        : 0;
    if (count > 0) {
        badge.style.display = 'inline-block';
        badge.innerText = count > 99 ? '99+' : String(count);
    } else {
        badge.style.display = 'none';
    }
}

// Valor "efetivo" de um lead: o recebido, ou a soma dos procedimentos orçados.
function leadEffectiveValue(l) {
if (l.valor_recebido) return parseFloat(l.valor_recebido) || 0;
return parseOrcamentoArray(l.orcamento).reduce((sum, item) => sum + (parseFloat(item.valor) || 0), 0);
}

// Ordena os leads que vão pro board conforme o seletor "Ordenar cards".
// Datas do D1 vêm como texto ISO no mesmo formato pra todas as linhas, então
// comparar string já dá ordem cronológica.
function sortLeadsForBoard(list, key) {
const byCreatedAsc = (a, b) => (a.created_at || '').localeCompare(b.created_at || '');
const cmp = {
    created_asc:   byCreatedAsc,
    created_desc:  (a, b) => (b.created_at || '').localeCompare(a.created_at || ''),
    value_desc:    (a, b) => leadEffectiveValue(b) - leadEffectiveValue(a) || byCreatedAsc(a, b),
    name_asc:      (a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR', { sensitivity: 'base' }),
    activity_desc: (a, b) => (b.assigned_at || b.created_at || '').localeCompare(a.assigned_at || a.created_at || ''),
};
return list.slice().sort(cmp[key] || byCreatedAsc);
}

function switchKanbanOwnerTab(tabType) {
    const tabAll = document.getElementById('ktab-all');
    const tabMe = document.getElementById('ktab-me');
    const filterOwner = document.getElementById('filter-owner');
    
    if (tabAll) tabAll.classList.remove('active');
    if (tabMe) tabMe.classList.remove('active');
    
    if (tabType === 'me') {
        if (tabMe) tabMe.classList.add('active');
        if (filterOwner && loggedUser && loggedUser.username) {
            filterOwner.value = loggedUser.username;
        }
    } else {
        if (tabAll) tabAll.classList.add('active');
        if (filterOwner) {
            filterOwner.value = '';
        }
    }
    
    localStorage.setItem('kanban_active_tab', tabType);
    renderBoard();
}

// Para evitar conflito caso a aba "Meus Leads" seja clicada antes das options renderizarem.
let _kanbanTabInitialized = false;

function renderBoard() {
updateKanbanEntradaBadge();
document.querySelectorAll('.card-list').forEach(col => col.innerHTML = '');

// Popular filtro de responsáveis com TODOS os atendentes cadastrados (não só
// quem já tem lead atribuído — senão quem ainda não recebeu nenhum lead some do filtro).
const ownerSelect = document.getElementById('filter-owner');
if (ownerSelect) {
const currentOwnerVal = ownerSelect.value;
let owners = (typeof displayNamesMap !== 'undefined' && Object.keys(displayNamesMap).length > 0)
    ? Object.keys(displayNamesMap)
    : Array.from(new Set(leads.filter(l => l.owner_id).map(l => l.owner_id)));

owners = owners.sort((a, b) => resolveDisplayName(a).localeCompare(resolveDisplayName(b)));

let optionsHTML = '<option value="">👤 Todos os Responsáveis</option>';
owners.forEach(owner => {
optionsHTML += `<option value="${escapeHtml(owner)}">${escapeHtml(resolveDisplayName(owner))}</option>`;
});

if (ownerSelect.innerHTML !== optionsHTML) {
ownerSelect.innerHTML = optionsHTML;
ownerSelect.value = currentOwnerVal; // Restore selection if it existed
}
}

// Inicializa a aba na primeira vez que o renderBoard roda
if (!_kanbanTabInitialized && typeof loggedUser !== 'undefined' && loggedUser) {
    _kanbanTabInitialized = true;
    const savedTab = localStorage.getItem('kanban_active_tab') || 'all';
    if (savedTab === 'me') {
        const tabMe = document.getElementById('ktab-me');
        const tabAll = document.getElementById('ktab-all');
        if (tabMe) tabMe.classList.add('active');
        if (tabAll) tabAll.classList.remove('active');
        if (ownerSelect) ownerSelect.value = loggedUser.username;
    }
}

// Sincroniza a visualização da aba ativa de acordo com o select (se o usuário mudar no dropdown manualmente)
if (ownerSelect) {
    const tabAll = document.getElementById('ktab-all');
    const tabMe = document.getElementById('ktab-me');
    if (ownerSelect.value === '') {
        if (tabAll) tabAll.classList.add('active');
        if (tabMe) tabMe.classList.remove('active');
    } else if (typeof loggedUser !== 'undefined' && loggedUser && ownerSelect.value === loggedUser.username) {
        if (tabMe) tabMe.classList.add('active');
        if (tabAll) tabAll.classList.remove('active');
    } else {
        if (tabAll) tabAll.classList.remove('active');
        if (tabMe) tabMe.classList.remove('active');
    }
}

// Aplicar Filtros (Fase 1.2)
const searchVal = (document.getElementById('filter-search')?.value || '').toLowerCase();
const ownerVal = document.getElementById('filter-owner')?.value || '';
const origemVal = document.getElementById('filter-origem')?.value || '';
const dateStart = document.getElementById('filter-date-start')?.value || '';
const dateEnd = document.getElementById('filter-date-end')?.value || '';
const hasSchedule = document.getElementById('filter-has-schedule')?.checked || false;

const filteredLeads = leads.filter(lead => {
// Busca textual
if (searchVal) {
const nome = (lead.nome || '').toLowerCase();
const tel = (lead.telefone || '').toLowerCase();
if (!nome.includes(searchVal) && !tel.includes(searchVal)) return false;
}
// Responsável
if (ownerVal && lead.owner_id !== ownerVal) return false;
// Origem — prefixo, não igualdade: lead de anúncio vem como "Meta Ads: <título do anúncio>",
// então "Meta Ads" tem que casar com isso também. As demais origens são exatas e o startsWith cobre.
if (origemVal) {
    const o = (lead.origem || '').toLowerCase();
    if (!o.startsWith(origemVal.toLowerCase())) return false;
}
// Apenas Agendados (checa se está na coluna Agendado ou tem agendamento)
if (hasSchedule && lead.column !== 'col-agendado' && !lead.agendamento) return false;
// Filtro de data (data de criação do lead)
if (dateStart || dateEnd) {
const rawDate = (lead.created_at || '');
const leadDate = rawDate.includes('T') ? rawDate.split('T')[0] : rawDate.split(' ')[0];
if (leadDate) {
if (dateStart && leadDate < dateStart) return false;
if (dateEnd && leadDate > dateEnd) return false;
}
}
return true;
});

// Ordenação dos cards (seletor "Ordenar cards" — persistido em localStorage).
const sortKey = localStorage.getItem('kanban-sort') || 'created_desc';
const sortSel = document.getElementById('kanban-sort');
if (sortSel && sortSel.value !== sortKey) sortSel.value = sortKey;
const sortedLeads = sortLeadsForBoard(filteredLeads, sortKey);

sortedLeads.forEach(lead => {
const col = document.getElementById(lead.column);
if (col) {
const card = document.createElement('div');
card.className = 'card';
card.draggable = false;
card.id = `card-${lead.id}`;
card.addEventListener('pointerdown', (e) => startKanbanCardDrag(e, lead.id, card));
card.addEventListener('contextmenu', (e) => openCardContextMenu(e, lead.id));

// 1. Procedimento de Interesse (Extração com fallback inteligente)
let procedimentoName = '';
const orcItems = parseOrcamentoArray(lead.orcamento);
if (orcItems.length > 0) {
procedimentoName = orcItems[orcItems.length - 1].procedimento || '';
if (orcItems.length > 1) procedimentoName += ` (+${orcItems.length - 1})`;
}
if (!procedimentoName && lead.notas) {
const keywords = ["Botox", "Preenchimento", "Harmonização", "Bioestimulador", "Limpeza de pele", "Laser", "Depilação", "Corporal"];
const found = keywords.find(kw => lead.notas.toLowerCase().includes(kw.toLowerCase()));
if (found) {
procedimentoName = found;
}
}
if (!procedimentoName) {
procedimentoName = 'Procedimento a Definir';
}
procedimentoName = escapeHtml(procedimentoName);

// 2. Tempo de Inatividade / Idade do Lead
let daysSince = 'Recente';
if (lead.created_at) {
const createdDate = parseSqlDate(lead.created_at);
// Math.floor (não ceil): um lead de hoje tem que dar "Hoje", não "1d atrás".
// Sem Math.abs: se o horário vier levemente no futuro (clock skew), continua "Hoje".
const diffDays = Math.floor((new Date() - createdDate) / 86400000);
daysSince = diffDays <= 0 ? 'Hoje' : `${diffDays}d atrás`;
}

// 3. Indicadores de Metadados
let metadataIconsHTML = '';
if (lead.notas) {
metadataIconsHTML += `<i class="fa-regular fa-note-sticky" style="color: var(--accent-warning); margin-right: 4px;" title="Possui observações salvas"></i> `;
}
if (orcItems.length > 0) {
metadataIconsHTML += `<i class="fa-solid fa-file-invoice-dollar" style="color: #38bdf8; margin-right: 4px;" title="Orçamento Gerado"></i> `;
}
if (lead.agendamento) {
metadataIconsHTML += `<i class="fa-regular fa-calendar-check" style="color: #2dd4bf; margin-right: 4px;" title="Agendamento Marcado: ${lead.agendamento.data} às ${lead.agendamento.hora}"></i> `;
}
        let unreadBadge = '';
        if (typeof allChatsList !== 'undefined' && lead.telefone) {
            const chat = allChatsList.find(c => {
                if (typeof isSamePhone === 'function') {
                    return isSamePhone(c.phone, lead.telefone);
                }
                return c.phone === lead.telefone;
            });
            const count = chat ? Number(chat.unread_count || 0) : 0;
            if (count > 0) {
                unreadBadge = `<div style="position: relative; display: inline-flex; align-items: center; justify-content: center; margin-right: 6px; cursor: pointer;" onclick="openChatForLead('${lead.telefone}', '${lead.id}')" title="${count} mensagem(ns) não lida(s)">
                    <i class="fa-brands fa-whatsapp" style="color: #25D366; font-size: 1.05rem;"></i>
                    <span style="position: absolute; top: -5px; right: -6px; background: #ef4444; color: white; font-size: 0.6rem; font-weight: 700; width: 14px; height: 14px; border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 1.5px solid var(--bg-card);">${count > 99 ? '99+' : count}</span>
                </div>`;
            }
        }
        
        metadataIconsHTML = unreadBadge + metadataIconsHTML;

        let tagsBadges = '';
if (lead.tags && typeof parseLeadTags === 'function') {
const leadTags = parseLeadTags(lead.tags);
tagsBadges = leadTags.map(tagId => getTagBadgeHTML(tagId)).join(' ');
}

const avatarHTML = typeof renderAvatarHTML === 'function' 
? renderAvatarHTML(lead.nome, null, 'online', 34) 
: '';

const isMetaAd = lead.origem && (lead.origem.includes('Meta Ads') || lead.origem.includes('Anúncio'));
const origemBadgeHTML = isMetaAd
? `<div class="tag" style="background: rgba(255, 255, 255, 0.04); color: var(--text-muted); border: none; font-weight: 500; box-shadow: none; outline: none; margin-top: 0;"><i class="fa-brands fa-facebook" style="color: #60a5fa;"></i> ${escapeHtml(lead.origem)}</div>`
: `<div class="tag" style="background: rgba(255, 255, 255, 0.04); color: var(--text-muted); margin-top: 0;"><i class="fa-solid fa-bullhorn" style="color: var(--text-muted);"></i> ${escapeHtml(lead.origem)}</div>`;

let valorBadgeHTML = '';
if (lead.valor_recebido) {
valorBadgeHTML = `<div class="tag" style="background: rgba(16, 185, 129, 0.12); color: #34d399; font-weight: 600; margin-top: 0;"><i class="fa-solid fa-dollar-sign"></i> R$ ${parseFloat(lead.valor_recebido).toFixed(2).replace('.', ',')}</div>`;
}

let ownerTag = '';
if (lead.owner_id) {
const ownerAvatarHTML = typeof renderAvatarHTML === 'function'
? renderAvatarHTML(resolveDisplayName(lead.owner_id), avatarMap[lead.owner_id] || null, null, 18)
: '';
ownerTag = `<div class="tag" style="background: rgba(255, 255, 255, 0.04); color: var(--text-muted); margin-top: 0; padding-left: 4px;">${ownerAvatarHTML} ${escapeHtml(resolveDisplayName(lead.owner_id))}</div>`;
}

card.innerHTML = `
<button class="card-options-btn" onclick="toggleCardDropdown(event, '${lead.id}')" style="position: absolute; right: 10px; top: 10px; background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 1.15rem; transition: 0.2s; padding: 0.2rem;" title="Opções"><i class="fa-solid fa-ellipsis-vertical"></i></button>

<div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.2rem; padding-right: 35px;">
${avatarHTML}
<div style="overflow: hidden; flex: 1; min-width: 0;">
<div class="card-title" title="${escapeHtml(lead.nome)}">${escapeHtml(lead.nome)}</div>
<div style="font-size: 0.8rem; font-weight: 500; color: #38bdf8; margin-top: 0.05rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"><i class="fa-solid fa-spa" style="font-size: 0.72rem; margin-right: 4px;"></i> ${procedimentoName}</div>
</div>
</div>

<div style="display: flex; justify-content: space-between; align-items: center; margin-top: 0.35rem; border-top: 1px solid rgba(255,255,255,0.03); padding-top: 0.45rem;">
<div style="display: flex; align-items: center; gap: 0.4rem; color: var(--text-muted); font-size: 0.8rem;">
${metadataIconsHTML}
</div>
<span style="font-size: 0.75rem; color: var(--text-muted); display: flex; align-items: center; gap: 4px; font-weight: 500;" title="Tempo desde a entrada"><i class="fa-regular fa-clock" style="font-size: 0.7rem;"></i> ${daysSince}</span>
</div>

<div style="display: flex; gap: 0.35rem; flex-wrap: wrap; margin-top: 0.4rem; align-items: center;">
${origemBadgeHTML}
${ownerTag}
${valorBadgeHTML}
${tagsBadges}
</div>
`;
col.appendChild(card);
}
});

// Atualiza contadores e estatísticas de oportunidades
['col-entrada', 'col-contatado', 'col-orcado', 'col-agendado', 'col-ganho', 'col-perdido'].forEach(id => {
const columnLeads = leads.filter(l => l.column === id);
const count = columnLeads.length;

// Pacientes count
const countEl = document.getElementById('count-' + id.replace('col-', ''));
if (countEl) {
countEl.innerText = count === 1 ? '1 paciente' : `${count} pacientes`;
}

// Soma valores potenciais
let totalVal = 0;
columnLeads.forEach(l => {
let val = 0;
if (l.valor_recebido) {
val = parseFloat(l.valor_recebido) || 0;
} else {
val = parseOrcamentoArray(l.orcamento).reduce((sum, item) => sum + (parseFloat(item.valor) || 0), 0);
}
totalVal += val;
});

const valEl = document.getElementById('value-' + id.replace('col-', ''));
if (valEl) {
if (totalVal > 0) {
valEl.innerText = totalVal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) + ' em oportunidades';
valEl.style.display = 'inline';
} else {
valEl.style.display = 'none';
}
}

// Se a coluna estiver vazia, renderiza o estado vazio
const colList = document.getElementById(id);
if (colList && colList.children.length === 0) {
const emptyMessages = {
'col-entrada': { title: 'Nenhuma nova oportunidade', desc: 'Novos pacientes aparecerão aqui conforme entrarem no CRM.', icon: 'fa-inbox' },
'col-contatado': { title: 'Nenhum contato recente', desc: 'Pacientes que já receberam mensagem comercial ficarão aqui.', icon: 'fa-comment-medical' },
'col-orcado': { title: 'Nenhum orçamento enviado', desc: 'Pacientes com valores em negociação aparecerão nesta etapa.', icon: 'fa-file-invoice-dollar' },
'col-agendado': { title: 'Nenhum agendamento marcado', desc: 'Pacientes com consulta ou procedimento agendado ficarão aqui.', icon: 'fa-calendar-check' },
'col-ganho': { title: 'Sem conversões recentes', desc: 'Os pacientes com pacotes fechados aparecerão aqui.', icon: 'fa-circle-check' },
'col-perdido': { title: 'Nada em follow up', desc: 'Leads que precisam de acompanhamento / retomada de contato ficarão nesta etapa.', icon: 'fa-arrow-rotate-left' }
};
const msg = emptyMessages[id] || { title: 'Sem registros', desc: 'Nenhum paciente nesta etapa.', icon: 'fa-folder-open' };
colList.innerHTML = `
<div class="empty-state" style="display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 1.5rem 0.85rem; color: var(--text-muted); opacity: 0.6; min-height: 120px; border: 1.5px dashed var(--border-color); border-radius: 8px; margin: 0.5rem 0; width: 100%; box-sizing: border-box;">
<i class="fa-solid ${msg.icon}" style="font-size: 1.5rem; margin-bottom: 0.5rem; color: var(--border-color);"></i>
<div style="font-size: 0.8rem; font-weight: 600; color: var(--text-main); margin-bottom: 0.15rem;">${msg.title}</div>
<div style="font-size: 0.72rem; line-height: 1.3;">${msg.desc}</div>
</div>
`;
}
});
}

// === DRAG AND DROP LOGIC ===
let draggedCardId = null;
let sourceColumnId = null;

// Arrastar os cards do Kanban via Pointer Events em vez do drag-and-drop
// nativo do HTML5 — o preview nativo (e o evento "drag" que atualizaria um
// fantasma customizado) é inconsistente demais entre navegadores (fica
// minúsculo, apagado, ou simplesmente não dispara). Pointer events são o
// mesmo mecanismo já usado (e comprovadamente confiável) no drag do dashboard.
let kanbanPointerDrag = null;
let kanbanDragGhost = null;
let kanbanDragLayer = null;
let kanbanHoveredColumn = null;
const KANBAN_DRAG_THRESHOLD = 6; // px — abaixo disso ainda conta como clique (ex: no "..." do card)

function startKanbanCardDrag(event, id, card) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.target.closest('.card-options-btn')) return;
    const rect = card.getBoundingClientRect();
    kanbanPointerDrag = {
        id,
        card,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        rect,
        moving: false
    };
}

function updateKanbanCardDrag(event) {
    if (!kanbanPointerDrag) return;
    const state = kanbanPointerDrag;

    if (!state.moving) {
        if (Math.abs(event.clientX - state.startX) < KANBAN_DRAG_THRESHOLD &&
            Math.abs(event.clientY - state.startY) < KANBAN_DRAG_THRESHOLD) return;

        // Só a partir daqui é um arraste de verdade (passou do limiar) — um
        // clique simples (ex: no botão "...") nunca chega a criar o fantasma.
        state.moving = true;
        draggedCardId = state.id;
        sourceColumnId = leads.find(l => l.id === state.id).column;
        state.card.classList.add('dragging');
        document.body.classList.add('kanban-dragging-body');
        state.card.setPointerCapture?.(state.pointerId);

        // Camada que contém o fantasma: fixed + inset:0 + overflow:hidden, então
        // por mais que o card seja arrastado pra fora da tela ele nunca aumenta a
        // largura do documento (era isso que "compactava" o site na horizontal).
        kanbanDragLayer = document.createElement('div');
        kanbanDragLayer.className = 'kanban-drag-layer';
        document.body.appendChild(kanbanDragLayer);

        kanbanDragGhost = state.card.cloneNode(true);
        kanbanDragGhost.removeAttribute('id');
        // O clone herda a classe "dragging" do original, e
        // ".card.dragging { visibility: hidden }" deixaria o fantasma invisível.
        kanbanDragGhost.classList.remove('dragging');
        kanbanDragGhost.classList.add('kanban-drag-ghost');
        kanbanDragGhost.style.width = `${state.rect.width}px`;
        kanbanDragLayer.appendChild(kanbanDragGhost);
    }

    if (!kanbanDragGhost) return;
    const x = event.clientX - state.offsetX;
    const y = event.clientY - state.offsetY;
    kanbanDragGhost.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(2deg) scale(1.04)`;

    // Destaca a coluna que está por baixo do cursor agora.
    const stack = document.elementsFromPoint(event.clientX, event.clientY);
    const under = stack.find(el => el !== kanbanDragGhost && !kanbanDragGhost.contains(el));
    const targetColumn = under ? under.closest('.card-list') : null;
    if (kanbanHoveredColumn && kanbanHoveredColumn !== targetColumn) {
        kanbanHoveredColumn.classList.remove('kanban-drop-hover');
    }
    if (targetColumn) targetColumn.classList.add('kanban-drop-hover');
    kanbanHoveredColumn = targetColumn;
}

function finishKanbanCardDrag(event) {
    if (!kanbanPointerDrag) return;
    const state = kanbanPointerDrag;
    if (state.moving) {
        state.card.classList.remove('dragging');
        document.body.classList.remove('kanban-dragging-body');
        if (kanbanDragGhost) { kanbanDragGhost.remove(); kanbanDragGhost = null; }
        if (kanbanDragLayer) { kanbanDragLayer.remove(); kanbanDragLayer = null; }
        if (kanbanHoveredColumn) {
            const targetColumnId = kanbanHoveredColumn.id;
            kanbanHoveredColumn.classList.remove('kanban-drop-hover');
            kanbanHoveredColumn = null;
            drop(event, targetColumnId);
        }
    } else {
        // Was a click (not a drag) — open lead profile
        if (!event.target.closest('.card-options-btn') && !event.target.closest('.card-dropdown')) {
            openLeadProfile(state.id);
        }
    }
    kanbanPointerDrag = null;
}

document.addEventListener('pointermove', updateKanbanCardDrag);
document.addEventListener('pointerup', finishKanbanCardDrag);
document.addEventListener('pointercancel', finishKanbanCardDrag);

// Mantido só porque as colunas ainda têm ondragover="allowDrop(event)" no HTML
// (inofensivo, nunca dispara pros nossos cards já que não são mais
// draggable=true — só existe pra não estourar erro se algo externo arrastado
// passar por cima do board).
function allowDrop(ev) {
    ev.preventDefault();
}

function drop(ev, targetColumnId) {
ev.preventDefault();
if (!draggedCardId || targetColumnId === sourceColumnId) return;

const leadIndex = leads.findIndex(l => l.id === draggedCardId);

// Atualiza estado e banco de dados imediatamente para garantir que o estágio foi alterado
leads[leadIndex].column = targetColumnId;
renderBoard();
updateLeadColumnOnServer(draggedCardId, targetColumnId);

// renderBoard() reconstrói o card do zero na nova coluna — adiciona uma
// animação de "encaixe" nele pra dar a sensação de movimento suave em vez de
// simplesmente aparecer pronto na nova posição.
const droppedCard = document.getElementById(`card-${draggedCardId}`);
if (droppedCard) {
    droppedCard.classList.add('card-landing');
    droppedCard.addEventListener('animationend', () => droppedCard.classList.remove('card-landing'), { once: true });
}

// Se moveu para agendado, comemora e só então abre o modal de integração.
// O modal cobre quase toda a tela com um overlay escuro assim que abre — disparar
// os dois no mesmo instante fazia o confete "sumir" atrás do formulário mal
// dava tempo de aparecer. Um pequeno atraso deixa a comemoração visível primeiro.
if (targetColumnId === 'col-agendado') {
celebrateAgendamento();
setTimeout(() => openAgendamentoModal(draggedCardId), 400);
}
// Se moveu para orçado, abre o modal de orçamento (Fase 2.1)
else if (targetColumnId === 'col-orcado') {
if (typeof openOrcamentoModal === 'function') {
openOrcamentoModal(draggedCardId);
}
}
// Se moveu para ganho, abre o modal de edição para registrar o Valor Recebido (Fase 1.5)
else if (targetColumnId === 'col-ganho') {
openNotesModal(draggedCardId);
}
}

// === AUTOCOMPLETE DE PACIENTES EXISTENTES NO AGENDAMENTO ===
let _buscaTimer = null; // Debounce para não chamar a API a cada letra
window.selectedPatientId = null; // Guardar ID do paciente se for existente

function buscarPacienteExistente(termo) {
const dropdown = document.getElementById('ag-patient-dropdown');
if (!dropdown) return;

window.selectedPatientId = null; // Reseta sempre que digitar algo

if (!termo || termo.length < 2) {
dropdown.style.display = 'none';
return;
}

// Mostra estado de carregando
dropdown.innerHTML = `<div style="padding:0.8rem 1rem; color:var(--text-muted); font-size:0.85rem;"><span class="amicro-loader"><span></span><span></span><span></span></span> Buscando pacientes...</div>`;
dropdown.style.display = 'block';

// Debounce: aguarda 500ms após o usuário parar de digitar para chamar a API
clearTimeout(_buscaTimer);
_buscaTimer = setTimeout(async () => {
try {
const _buscaUnidadeId = typeof getSelectedUnidadeId === 'function' ? getSelectedUnidadeId() : '';
const res = await fetch('/api/buscar-paciente?nome=' + encodeURIComponent(termo) + (_buscaUnidadeId ? '&unidade_id=' + encodeURIComponent(_buscaUnidadeId) : ''));
const data = await res.json();
const pacientes = data.pacientes || [];

// Também busca nos leads locais do CRM (instantâneo)
const termoLower = termo.toLowerCase();
const termoDigits = termo.replace(/\D/g, '');
const doLeads = (leads || [])
.filter(l => (l.nome && l.nome.toLowerCase().includes(termoLower)) || (termoDigits.length >= 3 && (l.telefone || '').replace(/\D/g, '').includes(termoDigits)))
.map(l => ({ nome: l.nome, telefone: l.telefone || '', fonte: 'CRM' }));

// Junta resultados (Amigo App + CRM local), sem duplicatas
const vistos = new Set(doLeads.map(l => l.nome.toLowerCase()));
const doAmigo = pacientes
.filter(p => !vistos.has(p.nome.toLowerCase()))
.map(p => ({ id: p.id, nome: p.nome, telefone: p.telefone || '', email: p.email || '', born: p.born || '', fonte: 'Amigo App' }));

const todos = [...doLeads, ...doAmigo];

const novoRow = `<div class="agx-pac-item agx-pac-new" onclick="document.getElementById('ag-patient-dropdown').style.display='none'; window.selectedPatientId=null;">
<i class="fa-solid fa-plus" style="font-size:0.72rem;"></i> Cadastrar novo paciente${termo ? ': “' + termo.replace(/</g, '&lt;').trim() + '”' : ''}</div>`;

if (todos.length === 0) {
dropdown.innerHTML = `<div style="padding:0.8rem 1rem; color:var(--text-muted); font-size:0.85rem;"><i class="fa-solid fa-user-slash"></i> Nenhum paciente encontrado.</div>` + novoRow;
return;
}

const fmtBorn = (b) => {
if (!b) return '';
const s = String(b).split('T')[0];
const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
return m ? ` · <i class="fa-regular fa-cake-candles" style="font-size:0.7rem;"></i> ${m[3]}/${m[2]}/${m[1]}` : '';
};

dropdown.innerHTML = todos.map(r => `
<div class="agx-pac-item" onclick="selecionarPaciente('${r.nome.replace(/'/g, "\\'")}', '${(r.telefone || '').replace(/'/g, "\\'")}', '${r.id || ''}', '${(r.email || '').replace(/'/g, "\\'")}', '${(r.born || '').replace(/'/g, "\\'")}')"
style="padding: 0.6rem 0.7rem; cursor: pointer; border-radius: 7px; transition: background 0.15s;"
onmouseover="this.style.background='var(--bg-hover)'" onmouseout="this.style.background='transparent'">
<div style="font-weight: 600; color: var(--text-main); font-size:0.85rem;">${r.nome}</div>
<div style="font-size: 0.78rem; color: var(--text-muted); margin-top:1px;">
<i class="fa-solid fa-phone" style="font-size:0.7rem;"></i> ${r.telefone || 'Sem telefone'}${fmtBorn(r.born)}
&nbsp;<span style="background: ${r.fonte === 'CRM' ? 'color-mix(in srgb, var(--accent-primary) 18%, transparent)' : 'rgba(251,146,60,0.2)'}; color: ${r.fonte === 'CRM' ? 'var(--accent-primary)' : '#fb923c'}; font-size:0.68rem; padding: 1px 6px; border-radius: 4px;">${r.fonte}</span>
</div>
</div>
`).join('') + novoRow;

} catch(e) {
dropdown.innerHTML = `<div style="padding:0.8rem 1rem; color:var(--accent-danger); font-size:0.85rem;"><i class="fa-solid fa-triangle-exclamation"></i> Erro ao buscar. Tente novamente.</div>`;
}
}, 500);
}

function selecionarPaciente(nome, telefone, id = '', email = '', born = '') {
const nameInput = document.getElementById('ag-patient-name');
const phoneInput = document.getElementById('ag-patient-phone');
const emailInput = document.getElementById('ag-patient-email');
const bornInput = document.getElementById('ag-patient-born');
const dropdown = document.getElementById('ag-patient-dropdown');

if (nameInput) nameInput.value = nome;
if (phoneInput) phoneInput.value = telefone;
if (emailInput && email) emailInput.value = email;
if (bornInput && born) {
// Formata data caso precise (geralmente YYYY-MM-DD para input date)
try {
bornInput.value = born.split('T')[0];
} catch(e) {
bornInput.value = born;
}
}

if (dropdown) dropdown.style.display = 'none';

window.selectedPatientId = id || null;
}

// Fecha o dropdown ao clicar fora
document.addEventListener('click', (e) => {
const dd = document.getElementById('ag-patient-dropdown');
const input = document.getElementById('ag-patient-name');
if (dd && input && !dd.contains(e.target) && e.target !== input) {
dd.style.display = 'none';
}
});



function openLeadChat(phone, name) {
    if (!phone) {
        if (typeof customAlert === 'function') {
            customAlert("Este lead não possui um número de WhatsApp cadastrado.");
        } else {
            alert("Este lead não possui um número de WhatsApp cadastrado.");
        }
        return;
    }
    const cleanPhone = phone.replace(/\D/g, '');
    switchTab('chat');
    openChat(cleanPhone, name || ('Contato ' + cleanPhone));
}

// === BUSCA GLOBAL DE PACIENTE (barra superior, presente em todas as páginas) ===
function buscarPacienteTopbar(term) {
    const dropdown = document.getElementById('topbar-patient-dropdown');
    if (!dropdown) return;
    const termLower = term.toLowerCase().trim();

    if (!termLower) {
        dropdown.style.display = 'none';
        return;
    }

    const nomesVistos = new Set();
    const resultados = [];

    (leads || []).forEach(lead => {
        if (!lead.nome) return;
        const nome = lead.nome.trim().toLowerCase();
        if (!nome.includes(termLower) || nomesVistos.has(nome)) return;
        nomesVistos.add(nome);
        resultados.push({ name: lead.nome, phone: lead.telefone || '' });
    });

    // Na tela de Histórico, também busca nos agendamentos já carregados na página
    // (cobre pacientes que ainda não têm lead no Kanban).
    (window.historicoData || []).forEach(row => {
        if (!row.nome_paciente) return;
        const nome = row.nome_paciente.trim().toLowerCase();
        if (!nome.includes(termLower) || nomesVistos.has(nome)) return;
        nomesVistos.add(nome);
        resultados.push({ name: row.nome_paciente, phone: row.telefone_paciente || '' });
    });

    if (resultados.length === 0) {
        dropdown.innerHTML = `<div style="padding: 0.8rem 1rem; color: var(--text-muted); font-size: 0.85rem; text-align: center;">Nenhum paciente encontrado.</div>`;
    } else {
        dropdown.innerHTML = resultados.slice(0, 20).map(r => {
            const phoneDisplay = r.phone
                ? (typeof formatPhoneDisplay === 'function' ? formatPhoneDisplay(r.phone) : r.phone)
                : '-';
            const safeName = escapeHtml(r.name).replace(/'/g, "\\'");
            const safePhone = (r.phone || '').replace(/'/g, "\\'");
            return `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 0.7rem 1rem; cursor: pointer; border-bottom: 1px solid var(--border-color);"
                onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='transparent'"
                onclick="selecionarPacienteTopbar('${safeName}', '${safePhone}')">
                <span style="font-weight: 500; color: var(--text-main); font-size: 0.85rem;">${escapeHtml(r.name)}</span>
                <span style="font-size: 0.75rem; background: rgba(255,255,255,0.1); padding: 0.2rem 0.4rem; border-radius: 4px; color: var(--text-muted);">${escapeHtml(phoneDisplay)}</span>
            </div>
            `;
        }).join('');
    }
    dropdown.style.display = 'block';
}

function selecionarPacienteTopbar(name, phone) {
    const dropdown = document.getElementById('topbar-patient-dropdown');
    const input = document.getElementById('topbar-patient-search');
    if (dropdown) dropdown.style.display = 'none';
    if (input) input.value = '';

    if (!phone) {
        if (typeof customAlert === 'function') customAlert("Este paciente não possui telefone cadastrado.");
        else alert("Este paciente não possui telefone cadastrado.");
        return;
    }

    if (typeof openChat === 'function') {
        // Já estamos na página com o chat (index.html): abre direto.
        openLeadChat(phone, name);
    } else {
        // Outras páginas (ex: Histórico) não carregam o chat: navega pro index.html
        // já indicando qual conversa abrir assim que a página carregar.
        window.location.href = `index.html?open_chat=${encodeURIComponent(phone)}&open_name=${encodeURIComponent(name)}`;
    }
}

document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('topbar-patient-dropdown');
    const input = document.getElementById('topbar-patient-search');
    if (dropdown && input && !input.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.style.display = 'none';
    }
});

async function changeLeadStatusFromChat(newColumn) {
    if (!window.currentActiveChat || !window.currentActiveChat.phone) return;
    const phone = window.currentActiveChat.phone;
    const name = window.currentActiveChat.name;

    let lead = leads.find(l => 
        l.telefone === phone || 
        l.telefone === '+' + phone || 
        (l.telefone && l.telefone.includes(phone)) ||
        (phone && phone.includes(l.telefone))
    );

    // Mesmos modais que abrem ao arrastar o card pra essas colunas no Kanban — sem
    // isso, mudar o estágio pra Orçado/Agendado/Ganho por aqui nunca pedia o valor
    // do negócio, ficando fora de sincronia com o comportamento do board.
    function openStageModal(leadId) {
        if (newColumn === 'col-agendado') {
            celebrateAgendamento();
            setTimeout(() => openAgendamentoModal(leadId), 400);
        } else if (newColumn === 'col-orcado' && typeof openOrcamentoModal === 'function') {
            setTimeout(() => openOrcamentoModal(leadId), 400);
        } else if (newColumn === 'col-ganho') {
            setTimeout(() => openNotesModal(leadId), 400);
        }
    }

    if (lead) {
        const wasAlreadyInColumn = lead.column === newColumn;
        lead.column = newColumn;
        renderBoard();
        await updateLeadColumnOnServer(lead.id, newColumn);
        if (!wasAlreadyInColumn) openStageModal(lead.id);
    } else {
        const currentUser = (typeof loggedUser !== 'undefined' && loggedUser) ? loggedUser.username : null;
        const newLead = {
            id: Date.now().toString(),
            nome: name && !name.includes('Contato') ? name : 'Lead WhatsApp',
            telefone: phone,
            origem: 'WhatsApp Orgânico',
            column: newColumn,
            owner_id: currentUser
        };
        leads.push(newLead);
        renderBoard();
        await saveLeadToServer(newLead);
        openStageModal(newLead.id);
    }
}

function findLeadFromActiveChat() {
    if (!window.currentActiveChat || !window.currentActiveChat.phone) return null;
    const phone = window.currentActiveChat.phone;
    // isSamePhone normaliza a variação do 9º dígito transicional dos dois lados
    // antes de comparar — a comparação por substring antiga falhava sempre que
    // o telefone salvo no lead e o da conversa ativa vinham em formatos diferentes.
    return leads.find(l => isSamePhone(l.telefone, phone)) || null;
}

async function toggleChatAiEnabled(checked) {
    const lead = findLeadFromActiveChat();
    if (!lead) return;
    lead.ai_enabled = checked ? 1 : 0;
    try {
        await fetch(`/api/leads/${lead.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ai_enabled: checked })
        });
    } catch (e) {
        console.error('Erro ao ligar/desligar a IA para o lead:', e);
    }
}

function manageLeadFromChat() {
    if (!window.currentActiveChat || !window.currentActiveChat.phone) return;

    const phone = window.currentActiveChat.phone;
    const name = window.currentActiveChat.name;
    const lead = findLeadFromActiveChat();

    if (lead) {
        viewLeadInKanban(lead.id);
    } else {
        document.getElementById('nl-nome').value = name && !name.includes('Contato') ? name : '';
        document.getElementById('nl-telefone').value = phone;
        openNewLeadModal();
    }
}

// Navega pro Kanban e destaca visualmente o card do lead — antes esse botão
// ("Ver no Kanban") abria por engano o modal de informações do lead em vez de
// realmente levar pro board.
function viewLeadInKanban(leadId) {
    switchTab('kanban');
    setTimeout(() => {
        const card = document.getElementById(`card-${leadId}`);
        if (!card) return;
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('card-highlight-pulse');
        setTimeout(() => card.classList.remove('card-highlight-pulse'), 2200);
    }, 150);
}

function scheduleLeadFromChat() {
    const lead = findLeadFromActiveChat();
    if (lead) openAgendamentoModal(lead.id);
}

function budgetLeadFromChat() {
    const lead = findLeadFromActiveChat();
    if (lead) openOrcamentoModal(lead.id);
}

// === MODAIS ===
function openNewLeadModal(columnId = 'col-entrada') {
    window.currentNewLeadColumn = columnId;
    document.getElementById('modalNewLead').classList.add('active');
}

function closeModals() {
    document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('active'));
    document.getElementById('nl-nome').value = '';
    document.getElementById('nl-telefone').value = '';
    const emailEl = document.getElementById('nl-email');
    if (emailEl) emailEl.value = '';
    const fbcEl = document.getElementById('nl-fb-click-id');
    if (fbcEl) fbcEl.value = '';
    
    document.getElementById('integrationLoader').classList.remove('active');
    document.getElementById('integrationActions').style.display = 'flex';
}

// Esc fecha qualquer modal aberto (.modal-overlay) — menos o overlay de login.
// Registrado cedo, então roda antes dos outros handlers de Esc (ficha do lead,
// chat); stopImmediatePropagation evita que eles disparem no mesmo Esc.
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!document.querySelector('.modal-overlay.active:not(#login-overlay)')) return;
    e.stopImmediatePropagation();
    closeModals();
});

async function saveNewLead() {
    const nome = document.getElementById('nl-nome').value;
    const telefone = document.getElementById('nl-telefone').value;
    const origem = document.getElementById('lead-origem').value;
    const born = document.getElementById('lead-born').value;
    const emailEl = document.getElementById('nl-email');
    const fbcEl = document.getElementById('nl-fb-click-id');
    const email = emailEl ? emailEl.value : '';
    const fb_click_id = fbcEl ? fbcEl.value : '';
    
    if(!telefone) {
        await customAlert("O número de WhatsApp é obrigatório para cadastrar o paciente!");
        return;
    }

    const newLead = {
        id: Date.now().toString(),
        nome: nome || 'Lead sem nome',
        telefone,
        origem,
        born,
        email,
        fb_click_id,
        column: window.currentNewLeadColumn || 'col-entrada'
    };

    leads.push(newLead);
    closeModals();
    renderBoard();
    saveLeadToServer(newLead);
}

function openNotesModal(id) {
    const lead = leads.find(l => l.id === id);
    if (!lead) return;
    document.getElementById('ln-lead-id').value = id;
    document.getElementById('ln-lead-name').value = lead.nome || '';
    document.getElementById('ln-lead-phone').value = lead.telefone || '';
    document.getElementById('ln-lead-born').value = lead.born || '';
    document.getElementById('ln-lead-email').value = lead.email || '';
    document.getElementById('ln-lead-fb-click').value = lead.fb_click_id || '';
    document.getElementById('ln-lead-origem').value = lead.origem || 'Meta Ads';
    document.getElementById('ln-notas').value = lead.notas || '';
    document.getElementById('ln-lead-valor').value = lead.valor_recebido ? formatCurrencyBRLValue(lead.valor_recebido) : '';
    document.getElementById('modalLeadNotes').classList.add('active');
}

async function saveLeadNotes() {
    const id = document.getElementById('ln-lead-id').value;
    const nome = document.getElementById('ln-lead-name').value;
    const telefone = document.getElementById('ln-lead-phone').value;
    const born = document.getElementById('ln-lead-born').value;
    const email = document.getElementById('ln-lead-email').value;
    const fb_click_id = document.getElementById('ln-lead-fb-click').value;
    const origem = document.getElementById('ln-lead-origem').value;
    const notas = document.getElementById('ln-notas').value;
    // O campo mostra "1.000,00" (máscara BRL), mas é armazenado como número puro
    // ("1000.00") pra continuar compatível com todo lugar que faz parseFloat(valor_recebido).
    const valor_recebido = parseCurrencyBRLInput(document.getElementById('ln-lead-valor').value);

    const lead = leads.find(l => l.id === id);
    if (lead) {
        lead.nome = nome || 'Desconhecido';
        lead.telefone = telefone;
        lead.born = born;
        lead.email = email;
        lead.fb_click_id = fb_click_id;
        lead.origem = origem;
        lead.notas = notas;
        lead.valor_recebido = valor_recebido ? parseFloat(valor_recebido) : null;
        renderBoard(); // atualiza a cor do icone de notas e os dados no card
        
        try {
            await fetch(`/api/leads/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nome: lead.nome, telefone, born, email, notas, valor_recebido: lead.valor_recebido })
            });
        } catch (e) {
            console.error('Erro ao salvar edições', e);
        }
    }

    document.getElementById('modalLeadNotes').classList.remove('active');

    // Se a ficha do lead está aberta, re-renderiza pra refletir a edição na hora.
    const lpp = document.getElementById('lead-profile-panel');
    if (lpp && lpp.classList.contains('active') && typeof openLeadProfile === 'function') {
        openLeadProfile(id);
    }
}

// Máscara de moeda BRL (1.234,56) digitada da direita pra esquerda, como app de banco:
// cada tecla empurra um dígito novo pros centavos e reformata o campo inteiro.
function maskCurrencyInput(el) {
    let digits = el.value.replace(/\D/g, '');
    if (!digits) { el.value = ''; return; }
    digits = digits.replace(/^0+(?=\d)/, '');
    while (digits.length < 3) digits = '0' + digits;
    const cents = digits.slice(-2);
    const intPart = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    el.value = intPart + ',' + cents;
}

// Converte um valor numérico "cru" (ex: "1000.00", vindo do banco) pro formato
// mascarado exibido no input (ex: "1.000,00").
function formatCurrencyBRLValue(rawValue) {
    const num = parseFloat(String(rawValue).replace(',', '.'));
    if (isNaN(num)) return '';
    return num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Converte o valor mascarado do input (ex: "1.000,00") de volta pra número puro
// (ex: "1000.00") — formato que todo o resto do sistema espera em orc.valor.
function parseCurrencyBRLInput(masked) {
    if (!masked) return '';
    const num = parseFloat(String(masked).replace(/\./g, '').replace(',', '.'));
    return isNaN(num) ? '' : num.toFixed(2);
}

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

function renderOrcamentoItemsList(id) {
    const lead = leads.find(l => l.id === id);
    const items = lead ? parseOrcamentoArray(lead.orcamento) : [];
    const isAdmin = typeof loggedUser !== 'undefined' && loggedUser && (loggedUser.role === 'admin' || loggedUser.username === 'admin');
    const container = document.getElementById('orc-items-list');

    if (items.length === 0) {
        container.innerHTML = `<div class="orcx-empty"><i class="fa-regular fa-folder-open"></i><span>Nenhum procedimento orçado ainda.<br>Adicione o primeiro no formulário abaixo.</span></div>`;
        return;
    }

    container.innerHTML = items.map(item => {
        const valorFmt = item.valor ? formatCurrencyBRLValue(item.valor) : '0,00';
        const descontoTxt = item.desconto ? ` &middot; <span class="orcx-disc">${item.desconto}% desconto</span>` : '';
        const formaTxt = item.formaPagamento ? ` &middot; ${escapeHtml(item.formaPagamento)}` : '';
        const whenTxt = item.created_at ? item.created_at.slice(0, 16).replace('T', ' ') : '';
        const creatorHTML = item.created_by ? `
            <div style="display: flex; align-items: center; gap: 0.35rem; font-size: 0.75rem; color: var(--text-muted); opacity: 0.9; margin-top: 0.35rem;">
                ${typeof renderAvatarHTML === 'function' ? renderAvatarHTML(resolveDisplayName(item.created_by), avatarMap[item.created_by] || null, null, 16) : ''}
                <span>${escapeHtml(resolveDisplayName(item.created_by))}${whenTxt ? ` em ${whenTxt}` : ''}</span>
            </div>
        ` : (whenTxt ? `<div style="font-size: 0.75rem; color: var(--text-muted); opacity: 0.75; margin-top: 0.25rem;">${whenTxt}</div>` : '');
        const actions = (isAdmin && item.id !== 'legacy') ? `
            <button title="Editar" onclick="editOrcamentoItem('${item.id}')"><i class="fa-solid fa-pen"></i></button>
            <button class="orcx-del" title="Excluir" onclick="deleteOrcamentoItem('${item.id}')"><i class="fa-solid fa-trash"></i></button>
        ` : '';
        return `
            <div class="orcx-item">
                <div>
                    <div class="orcx-item-name">${item.procedimento || '(sem nome)'}</div>
                    <div class="orcx-item-meta">R$ ${valorFmt}${descontoTxt}${formaTxt}</div>
                    ${item.condicoes ? `<div class="orcx-item-cond">${item.condicoes}</div>` : ''}
                    ${creatorHTML}
                </div>
                <div class="orcx-item-actions">${actions}</div>
            </div>
        `;
    }).join('');
}

// Prévia do valor com desconto no modal de Orçamento (apenas visual).
function orcUpdatePreview() {
    const box = document.getElementById('orc-preview');
    const out = document.getElementById('orc-preview-value');
    if (!box || !out) return;
    const valorEl = document.getElementById('orc-valor');
    const descEl = document.getElementById('orc-desconto');
    const valor = parseFloat(parseCurrencyBRLInput(valorEl ? valorEl.value : '')) || 0;
    const desc = Math.min(Math.max(parseFloat(descEl ? descEl.value : '') || 0, 0), 100);
    if (valor <= 0) { box.hidden = true; return; }
    const final = valor * (1 - desc / 100);
    out.textContent = 'R$ ' + final.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    box.hidden = false;
}

function openOrcamentoModal(id) {
    const lead = leads.find(l => l.id === id);
    if (!lead) return;
    document.getElementById('orc-lead-id').value = id;
    cancelEditOrcamentoItem();
    renderOrcamentoItemsList(id);
    orcPreencherPaciente(lead);
    orcUpdatePreview();
    // Carrega as empresas e pré-seleciona a do lead (ou a padrão) no seletor.
    fetchEmpresas().then(() => orcPopularEmpresaSelect(lead.empresa_id)).catch(() => {});
    document.getElementById('modalOrcamento').classList.add('active');
}

// Preenche os campos "Dados do paciente" do modal de Orçamento a partir do lead.
function orcPreencherPaciente(lead) {
    const set = (elId, v) => { const el = document.getElementById(elId); if (el) el.value = v || ''; };
    set('orc-pac-nome', lead.nome);
    set('orc-pac-cpf', lead.cpf);
    set('orc-pac-telefone', lead.telefone);
    set('orc-pac-endereco', lead.endereco);
    const busca = document.getElementById('orc-pac-busca');
    if (busca) busca.value = '';
    const dd = document.getElementById('orc-pac-dropdown');
    if (dd) { dd.style.display = 'none'; dd.innerHTML = ''; }
    clearTimeout(_orcPacienteTimer);
    _orcPacienteDirty = false;
    orcSetSaveState('');
}

// ── Máscaras CPF / CNPJ ────────────────────────────────────────────────
function orcMaskCpf(el) {
    let d = el.value.replace(/\D/g, '').slice(0, 11);
    if (d.length > 9) el.value = `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9)}`;
    else if (d.length > 6) el.value = `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6)}`;
    else if (d.length > 3) el.value = `${d.slice(0,3)}.${d.slice(3)}`;
    else el.value = d;
}

function orcMaskCnpj(el) {
    let d = el.value.replace(/\D/g, '').slice(0, 14);
    let out = d;
    if (d.length > 12) out = `${d.slice(0,2)}.${d.slice(2,5)}.${d.slice(5,8)}/${d.slice(8,12)}-${d.slice(12)}`;
    else if (d.length > 8) out = `${d.slice(0,2)}.${d.slice(2,5)}.${d.slice(5,8)}/${d.slice(8)}`;
    else if (d.length > 5) out = `${d.slice(0,2)}.${d.slice(2,5)}.${d.slice(5)}`;
    else if (d.length > 2) out = `${d.slice(0,2)}.${d.slice(2)}`;
    el.value = out;
}

// ── Busca de paciente (leads, incluindo contatos vindos do WhatsApp) ───
function orcBuscarPaciente(term) {
    const dd = document.getElementById('orc-pac-dropdown');
    if (!dd) return;
    const t = (term || '').trim().toLowerCase();
    const tDigits = t.replace(/\D/g, '');
    if (t.length < 2) { dd.style.display = 'none'; dd.innerHTML = ''; return; }

    const matches = (Array.isArray(leads) ? leads : []).filter(l => {
        const nome = (l.nome || '').toLowerCase();
        const tel = (l.telefone || '').replace(/\D/g, '');
        return nome.includes(t) || (tDigits.length >= 3 && tel.includes(tDigits));
    }).slice(0, 8);

    if (matches.length === 0) {
        dd.innerHTML = `<div class="ag-dropdown-item" style="opacity:.6;cursor:default;">Nenhum paciente encontrado</div>`;
        dd.style.display = 'block';
        return;
    }

    dd.innerHTML = matches.map(l => `
        <div class="ag-dropdown-item" onclick="orcSelecionarPaciente('${l.id}')">
            <strong>${escapeHtml(l.nome || 'Sem nome')}</strong>
            <span style="opacity:.7;"> · ${escapeHtml(l.telefone || 'sem telefone')}</span>
        </div>
    `).join('');
    dd.style.display = 'block';
}

function orcSelecionarPaciente(leadId) {
    const lead = (Array.isArray(leads) ? leads : []).find(l => l.id === leadId);
    if (!lead) return;
    document.getElementById('orc-lead-id').value = lead.id;
    orcPreencherPaciente(lead);
    renderOrcamentoItemsList(lead.id);
    cancelEditOrcamentoItem();
}

// Salva alterações nos dados do paciente (debounce) no lead correspondente.
let _orcPacienteTimer = null;
let _orcPacienteDirty = false;
function orcPacienteDirty() {
    _orcPacienteDirty = true;
    orcSetSaveState('editando');
    clearTimeout(_orcPacienteTimer);
    _orcPacienteTimer = setTimeout(() => orcSalvarPaciente(true), 800);
}

// Indicador visual "editando / salvando / salvo" ao lado do título da seção.
function orcSetSaveState(state) {
    const el = document.getElementById('orc-pac-status');
    if (!el) return;
    if (state === 'editando') { el.textContent = 'alterações não salvas'; el.dataset.s = 'dirty'; }
    else if (state === 'salvando') { el.textContent = 'salvando…'; el.dataset.s = 'saving'; }
    else if (state === 'salvo') { el.textContent = 'salvo ✓'; el.dataset.s = 'saved'; }
    else { el.textContent = ''; el.dataset.s = ''; }
}

async function orcSalvarPaciente(silent) {
    clearTimeout(_orcPacienteTimer);
    const id = document.getElementById('orc-lead-id').value;
    if (!id) return;
    const lead = (Array.isArray(leads) ? leads : []).find(l => l.id === id);
    if (!lead) return;
    if (!_orcPacienteDirty) return;

    const nome = document.getElementById('orc-pac-nome').value.trim();
    const telefone = document.getElementById('orc-pac-telefone').value.trim();
    const cpf = document.getElementById('orc-pac-cpf').value.trim();
    const endereco = document.getElementById('orc-pac-endereco').value.trim();

    lead.nome = nome || lead.nome;
    lead.telefone = telefone;
    lead.cpf = cpf;
    lead.endereco = endereco;
    if (typeof renderBoard === 'function') renderBoard();

    orcSetSaveState('salvando');
    try {
        const res = await fetch(`/api/leads/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome: lead.nome, telefone, cpf, endereco })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        _orcPacienteDirty = false;
        orcSetSaveState('salvo');
        if (!silent) showToast('Dados do paciente salvos.', 'success');
    } catch (e) {
        console.error('Erro ao salvar dados do paciente', e);
        orcSetSaveState('editando');
        if (!silent) showToast('Não foi possível salvar os dados do paciente.', 'danger');
    }
}

// Fecha o modal de orçamento garantindo que edições pendentes do paciente sejam gravadas.
async function orcFecharModal() {
    if (_orcPacienteDirty) await orcSalvarPaciente(false);
    closeModals();
}

// ── Empresas / emitentes do orçamento ────────────────────────────────
// Cadastro com várias empresas; cada lead pode apontar pra uma (lead.empresa_id).
// Na impressão resolve: empresa do lead -> padrão -> primeira ativa.
let orcEmpresasCache = [];

async function fetchEmpresas(force) {
    if (orcEmpresasCache.length && !force) return orcEmpresasCache;
    try {
        const res = await fetch('/api/empresas');
        const json = await res.json();
        orcEmpresasCache = Array.isArray(json.empresas) ? json.empresas : [];
    } catch (e) {
        console.error('Erro ao carregar empresas', e);
    }
    return orcEmpresasCache;
}

function orcEmpresaById(id) {
    return orcEmpresasCache.find(e => e.id === id) || null;
}

function orcEmpresaPadrao() {
    return orcEmpresasCache.find(e => e.ativo && e.is_default)
        || orcEmpresasCache.find(e => e.ativo)
        || orcEmpresasCache[0]
        || null;
}

// Preenche o <select id="orc-empresa"> do modal de orçamento e pré-seleciona
// a empresa do lead (ou a padrão).
function orcPopularEmpresaSelect(empresaIdDoLead) {
    const sel = document.getElementById('orc-empresa');
    if (!sel) return;
    const ativas = orcEmpresasCache.filter(e => e.ativo);
    if (ativas.length === 0) {
        sel.innerHTML = '<option value="">Nenhuma empresa cadastrada</option>';
        sel.value = '';
        return;
    }
    const escolhida = (empresaIdDoLead && orcEmpresaById(empresaIdDoLead) && orcEmpresaById(empresaIdDoLead).ativo)
        ? empresaIdDoLead
        : (orcEmpresaPadrao() ? orcEmpresaPadrao().id : '');
    sel.innerHTML = ativas.map(e =>
        `<option value="${e.id}">${escapeHtml(e.nome_fantasia || e.razao_social)}${e.is_default ? ' (padrão)' : ''}</option>`
    ).join('');
    sel.value = escolhida;
}

// Grava no lead qual empresa emitir o orçamento.
async function orcSetEmpresaLead(empresaId) {
    const id = document.getElementById('orc-lead-id').value;
    if (!id) return;
    const lead = (Array.isArray(leads) ? leads : []).find(l => l.id === id);
    if (lead) lead.empresa_id = empresaId || null;
    try {
        await fetch(`/api/leads/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ empresa_id: empresaId || null })
        });
    } catch (e) {
        console.error('Erro ao vincular empresa ao lead', e);
    }
}

// Logo da empresa em memória (data URI) enquanto o modal está aberto.
// null = ainda não mexeram; '' = removeram de propósito.
let empLogoData = null;

function orcRenderEmpLogoPreview(dataUri) {
    const box = document.getElementById('emp-logo-preview');
    const rm = document.getElementById('emp-logo-remove');
    if (!box) return;
    if (dataUri) {
        box.innerHTML = `<img src="${dataUri}" alt="Logo">`;
        if (rm) rm.style.display = '';
    } else {
        box.innerHTML = '<i class="fa-regular fa-image"></i>';
        if (rm) rm.style.display = 'none';
    }
}

function orcEmpresaLogoPick(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
        showToast('Imagem muito grande (máx. 4 MB).', 'danger');
        input.value = '';
        return;
    }
    const reader = new FileReader();
    reader.onload = () => {
        // SVG é texto leve — guarda como veio. Raster passa por downscale.
        if (file.type === 'image/svg+xml') {
            empLogoData = reader.result;
            orcRenderEmpLogoPreview(empLogoData);
            input.value = '';
            return;
        }
        const img = new Image();
        img.onload = () => {
            const MAX = 480;
            let { width, height } = img;
            if (width > MAX || height > MAX) {
                const r = Math.min(MAX / width, MAX / height);
                width = Math.round(width * r);
                height = Math.round(height * r);
            }
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            // PNG preserva transparência; se ficar pesado, cai pra JPEG.
            let out = canvas.toDataURL('image/png');
            if (out.length > 300000) out = canvas.toDataURL('image/jpeg', 0.85);
            empLogoData = out;
            orcRenderEmpLogoPreview(empLogoData);
            input.value = '';
        };
        img.onerror = () => { showToast('Não foi possível ler a imagem.', 'danger'); input.value = ''; };
        img.src = reader.result;
    };
    reader.onerror = () => { showToast('Não foi possível ler o arquivo.', 'danger'); input.value = ''; };
    reader.readAsDataURL(file);
}

function orcEmpresaLogoRemove() {
    empLogoData = '';
    orcRenderEmpLogoPreview('');
}

// ── Gerenciador de empresas (lista + editor) ─────────────────────────
function empMostrarVista(qual) {
    const isEditor = qual === 'editor';
    document.getElementById('emp-list-view').style.display = isEditor ? 'none' : '';
    document.getElementById('emp-editor-view').style.display = isEditor ? '' : 'none';
    document.getElementById('emp-list-actions').style.display = isEditor ? 'none' : '';
    document.getElementById('emp-editor-actions').style.display = isEditor ? '' : 'none';
}

function closeEmpresasManager() {
    document.getElementById('modalOrcamentoEmpresa').classList.remove('active');
}

async function openEmpresasManager() {
    document.getElementById('modalOrcamentoEmpresa').classList.add('active');
    empMostrarVista('lista');
    document.getElementById('emp-list').innerHTML =
        '<div class="emp-empty"><span class="amicro-loader"><span></span><span></span><span></span></span> Carregando…</div>';
    await fetchEmpresas(true);
    empRenderLista();
}

function empRenderLista() {
    const box = document.getElementById('emp-list');
    if (!box) return;
    if (orcEmpresasCache.length === 0) {
        box.innerHTML = '<div class="emp-empty">Nenhuma empresa cadastrada ainda.</div>';
        return;
    }
    box.innerHTML = orcEmpresasCache.map(e => `
        <div class="emp-card">
            <div class="emp-card-logo">
                ${e.logo ? `<img src="${e.logo}" alt="">` : '<i class="fa-solid fa-building"></i>'}
            </div>
            <div class="emp-card-info">
                <div class="emp-card-name">${escapeHtml(e.nome_fantasia || e.razao_social)}${e.is_default ? '<span class="emp-badge">Padrão</span>' : ''}${!e.ativo ? '<span class="emp-badge" style="color:#e5a24d;">Inativa</span>' : ''}</div>
                <div class="emp-card-sub">${escapeHtml(e.cnpj || 'sem CNPJ')}</div>
            </div>
            <div class="emp-card-actions">
                <button title="Editar" onclick="empEditar('${e.id}')"><i class="fa-solid fa-pen"></i></button>
                ${e.is_default ? '' : `<button title="Tornar padrão" onclick="empTornarPadrao('${e.id}')"><i class="fa-solid fa-star"></i></button>`}
                <button class="danger" title="Excluir" onclick="empExcluir('${e.id}')"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>
    `).join('');
}

function empLimparEditor() {
    empLogoData = null;
    ['emp-editing-id', 'emp-razao', 'emp-fantasia', 'emp-cnpj', 'emp-ie', 'emp-im',
     'emp-endereco', 'emp-telefone', 'emp-email', 'emp-site', 'emp-resp', 'emp-pagamento']
        .forEach(elId => { const el = document.getElementById(elId); if (el) el.value = ''; });
    document.getElementById('emp-default').checked = false;
    orcRenderEmpLogoPreview('');
}

function empNovo() {
    empLimparEditor();
    document.getElementById('emp-default').checked = orcEmpresasCache.length === 0;
    empMostrarVista('editor');
}

function empEditar(id) {
    const e = orcEmpresaById(id);
    if (!e) return;
    empLimparEditor();
    const set = (elId, v) => { const el = document.getElementById(elId); if (el) el.value = v || ''; };
    set('emp-editing-id', e.id);
    set('emp-razao', e.razao_social);
    set('emp-fantasia', e.nome_fantasia);
    set('emp-cnpj', e.cnpj);
    set('emp-ie', e.inscricao_estadual);
    set('emp-im', e.inscricao_municipal);
    set('emp-endereco', e.endereco);
    set('emp-telefone', e.telefone);
    set('emp-email', e.email);
    set('emp-site', e.site);
    set('emp-resp', e.responsavel_tecnico);
    set('emp-pagamento', e.dados_pagamento);
    document.getElementById('emp-default').checked = !!e.is_default;
    orcRenderEmpLogoPreview(e.logo || '');
    empMostrarVista('editor');
}

function empVoltarLista() {
    empMostrarVista('lista');
}

async function empSalvar() {
    const val = elId => (document.getElementById(elId).value || '').trim();
    const id = val('emp-editing-id');
    if (!val('emp-razao')) {
        showToast('Informe a razão social.', 'danger');
        return;
    }
    const payload = {
        razao_social: val('emp-razao'),
        nome_fantasia: val('emp-fantasia'),
        cnpj: val('emp-cnpj'),
        inscricao_estadual: val('emp-ie'),
        inscricao_municipal: val('emp-im'),
        endereco: val('emp-endereco'),
        telefone: val('emp-telefone'),
        email: val('emp-email'),
        site: val('emp-site'),
        responsavel_tecnico: val('emp-resp'),
        dados_pagamento: val('emp-pagamento'),
        is_default: document.getElementById('emp-default').checked
    };
    // Só manda `logo` se mexeram: data URI novo, ou '' pra apagar.
    if (empLogoData !== null) payload.logo = empLogoData;

    try {
        const res = await fetch(id ? `/api/empresas/${id}` : '/api/empresas', {
            method: id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
            showToast(json.error || 'Não foi possível salvar.', 'danger');
            return;
        }
        // Se marcou como padrão ao editar, o POST já cuida; no PUT precisa do PATCH.
        if (id && payload.is_default && !(orcEmpresaById(id) || {}).is_default) {
            await fetch(`/api/empresas/${id}/default`, { method: 'PATCH' });
        }
        await fetchEmpresas(true);
        empRenderLista();
        empVoltarLista();
        showToast('Empresa salva.', 'success');
        // Reflete no seletor do orçamento, se estiver aberto.
        const leadId = document.getElementById('orc-lead-id').value;
        const lead = (Array.isArray(leads) ? leads : []).find(l => l.id === leadId);
        orcPopularEmpresaSelect(lead ? lead.empresa_id : null);
    } catch (e) {
        console.error('Erro ao salvar empresa', e);
        showToast('Erro ao salvar empresa.', 'danger');
    }
}

async function empTornarPadrao(id) {
    try {
        const res = await fetch(`/api/empresas/${id}/default`, { method: 'PATCH' });
        if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            showToast(j.error || 'Não foi possível definir a padrão.', 'danger');
            return;
        }
        await fetchEmpresas(true);
        empRenderLista();
        const leadId = document.getElementById('orc-lead-id').value;
        const lead = (Array.isArray(leads) ? leads : []).find(l => l.id === leadId);
        orcPopularEmpresaSelect(lead ? lead.empresa_id : null);
    } catch (e) {
        console.error('Erro ao definir empresa padrão', e);
    }
}

async function empExcluir(id) {
    const e = orcEmpresaById(id);
    if (!e) return;
    if (typeof customConfirm === 'function') {
        if (!(await customConfirm(`Excluir a empresa "${e.nome_fantasia || e.razao_social}"? Orçamentos que a usavam passam a usar a empresa padrão.`, 'Excluir empresa'))) return;
    } else if (!confirm('Excluir esta empresa?')) {
        return;
    }
    try {
        const res = await fetch(`/api/empresas/${id}`, { method: 'DELETE' });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
            showToast(j.error || 'Não foi possível excluir.', 'danger');
            return;
        }
        await fetchEmpresas(true);
        empRenderLista();
        showToast('Empresa excluída.', 'success');
        const leadId = document.getElementById('orc-lead-id').value;
        const lead = (Array.isArray(leads) ? leads : []).find(l => l.id === leadId);
        orcPopularEmpresaSelect(lead ? lead.empresa_id : null);
    } catch (e2) {
        console.error('Erro ao excluir empresa', e2);
        showToast('Erro ao excluir empresa.', 'danger');
    }
}

// Consulta o CNPJ digitado e pré-preenche o formulário.
async function empBuscarCnpj() {
    const btn = document.getElementById('emp-cnpj-lookup');
    const digits = (document.getElementById('emp-cnpj').value || '').replace(/\D/g, '');
    if (digits.length !== 14) {
        showToast('Digite os 14 dígitos do CNPJ.', 'danger');
        return;
    }
    const htmlOrig = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="amicro-loader"><span></span><span></span><span></span></span>'; }
    try {
        const res = await fetch(`/api/empresas/lookup-cnpj/${digits}`);
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
            showToast(j.error || 'Não foi possível consultar o CNPJ.', 'danger');
            return;
        }
        const d = j.empresa || {};
        const setIfEmpty = (elId, v) => {
            const el = document.getElementById(elId);
            if (el && v && !el.value.trim()) el.value = v;
        };
        if (d.razao_social) document.getElementById('emp-razao').value = d.razao_social;
        setIfEmpty('emp-fantasia', d.nome_fantasia);
        setIfEmpty('emp-endereco', d.endereco);
        setIfEmpty('emp-telefone', d.telefone);
        setIfEmpty('emp-email', d.email);
        showToast('Dados do CNPJ carregados. Confira antes de salvar.', 'success');
    } catch (e) {
        console.error('Erro no lookup de CNPJ', e);
        showToast('Consulta de CNPJ indisponível agora.', 'danger');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = htmlOrig; }
    }
}

// ── Impressão do orçamento ───────────────────────────────────────────
async function imprimirOrcamento() {
    const id = document.getElementById('orc-lead-id').value;
    const lead = (Array.isArray(leads) ? leads : []).find(l => l.id === id);
    const itens = lead ? parseOrcamentoArray(lead.orcamento) : [];

    if (itens.length === 0) {
        showToast('Adicione ao menos um procedimento antes de imprimir.', 'danger');
        return;
    }

    // Empresa emitente: a escolhida no seletor -> a do lead -> a padrão.
    if (orcEmpresasCache.length === 0) { try { await fetchEmpresas(true); } catch (e) {} }
    const empSelId = (document.getElementById('orc-empresa') || {}).value || (lead && lead.empresa_id) || '';
    let emp = orcEmpresaById(empSelId) || orcEmpresaPadrao() || {};

    const pac = {
        nome: document.getElementById('orc-pac-nome').value.trim(),
        cpf: document.getElementById('orc-pac-cpf').value.trim(),
        telefone: document.getElementById('orc-pac-telefone').value.trim(),
        endereco: document.getElementById('orc-pac-endereco').value.trim()
    };

    const brl = n => 'R$ ' + (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    let total = 0;
    const linhas = itens.map(it => {
        const valor = parseFloat(String(it.valor).replace(',', '.')) || 0;
        const desc = Math.min(Math.max(parseFloat(it.desconto) || 0, 0), 100);
        const final = valor * (1 - desc / 100);
        total += final;
        return `<tr>
            <td>${escapeHtml(it.procedimento || '—')}</td>
            <td class="num">${brl(valor)}</td>
            <td class="num">${desc ? desc + '%' : '—'}</td>
            <td class="num">${brl(final)}</td>
            <td>${escapeHtml(it.formaPagamento || '—')}</td>
        </tr>${it.condicoes ? `<tr class="cond"><td colspan="5">${escapeHtml(it.condicoes)}</td></tr>` : ''}`;
    }).join('');

    const hoje = new Date();
    const dataEmissao = hoje.toLocaleDateString('pt-BR');
    const validade = new Date(hoje.getTime() + 15 * 86400000).toLocaleDateString('pt-BR');

    const row = (label, val) => val ? `<div><span class="lbl">${label}</span> ${escapeHtml(val)}</div>` : '';

    const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Orçamento${pac.nome ? ' - ' + escapeHtml(pac.nome) : ''}</title>
<style>
    * { box-sizing: border-box; }
    body { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; margin: 0; padding: 40px; font-size: 13px; line-height: 1.5; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .muted { color: #666; }
    .doc-head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #333; padding-bottom: 16px; margin-bottom: 20px; gap: 24px; }
    .doc-head .company { max-width: 60%; display: flex; gap: 14px; align-items: flex-start; }
    .doc-head .company .logo { max-height: 64px; max-width: 180px; object-fit: contain; flex-shrink: 0; }
    .doc-head .company .name { font-size: 16px; font-weight: 700; }
    .doc-title { text-align: right; }
    .doc-title .big { font-size: 22px; font-weight: 700; letter-spacing: 1px; }
    .block { margin-bottom: 20px; }
    .block h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #555; border-bottom: 1px solid #ddd; padding-bottom: 4px; margin: 0 0 8px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; }
    .lbl { color: #888; display: inline-block; min-width: 70px; }
    table { width: 100%; border-collapse: collapse; margin-top: 4px; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e2e2e2; }
    th { background: #f4f4f4; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }
    td.num, th.num { text-align: right; white-space: nowrap; }
    tr.cond td { font-size: 11px; color: #666; padding-top: 2px; border-bottom: 1px solid #e2e2e2; }
    .total { text-align: right; font-size: 16px; font-weight: 700; margin-top: 12px; }
    .foot { margin-top: 32px; font-size: 11px; color: #666; border-top: 1px solid #ddd; padding-top: 12px; }
    .sign { margin-top: 56px; display: flex; justify-content: space-between; gap: 40px; }
    .sign div { flex: 1; border-top: 1px solid #333; padding-top: 6px; text-align: center; font-size: 11px; }
    @media print { body { padding: 0; } .noprint { display: none; } }
    .noprint { position: fixed; top: 12px; right: 12px; }
    .noprint button { padding: 8px 16px; font-size: 13px; cursor: pointer; }
</style></head><body>
<div class="noprint"><button onclick="window.print()">Imprimir</button></div>

<div class="doc-head">
    <div class="company">
        ${emp.logo ? `<img class="logo" src="${emp.logo}" alt="">` : ''}
        <div>
            <div class="name">${escapeHtml(emp.nome_fantasia || emp.razao_social || 'Sua Empresa')}</div>
            ${emp.nome_fantasia && emp.razao_social && emp.nome_fantasia !== emp.razao_social ? `<div class="muted">${escapeHtml(emp.razao_social)}</div>` : ''}
            ${emp.cnpj ? `<div class="muted">CNPJ: ${escapeHtml(emp.cnpj)}</div>` : ''}
            ${(emp.inscricao_estadual || emp.inscricao_municipal) ? `<div class="muted">${[emp.inscricao_estadual ? 'IE: ' + escapeHtml(emp.inscricao_estadual) : '', emp.inscricao_municipal ? 'IM: ' + escapeHtml(emp.inscricao_municipal) : ''].filter(Boolean).join(' · ')}</div>` : ''}
            ${emp.endereco ? `<div class="muted">${escapeHtml(emp.endereco)}</div>` : ''}
            ${emp.telefone ? `<div class="muted">Tel: ${escapeHtml(emp.telefone)}</div>` : ''}
            ${emp.email ? `<div class="muted">${escapeHtml(emp.email)}</div>` : ''}
            ${emp.site ? `<div class="muted">${escapeHtml(emp.site)}</div>` : ''}
        </div>
    </div>
    <div class="doc-title">
        <div class="big">ORÇAMENTO</div>
        <div class="muted">Emissão: ${dataEmissao}</div>
        <div class="muted">Válido até: ${validade}</div>
    </div>
</div>

<div class="block">
    <h2>Dados do paciente</h2>
    <div class="grid">
        ${row('Nome', pac.nome) || '<div class="muted">Paciente não informado</div>'}
        ${row('CPF', pac.cpf)}
        ${row('Telefone', pac.telefone)}
        ${row('Endereço', pac.endereco)}
    </div>
</div>

<div class="block">
    <h2>Itens do orçamento</h2>
    <table>
        <thead><tr>
            <th>Produto / Serviço</th>
            <th class="num">Valor</th>
            <th class="num">Desconto</th>
            <th class="num">Valor final</th>
            <th>Forma de pagamento</th>
        </tr></thead>
        <tbody>${linhas}</tbody>
    </table>
    <div class="total">Total: ${brl(total)}</div>
</div>

${emp.dados_pagamento ? `<div class="block">
    <h2>Dados para pagamento</h2>
    <div class="muted" style="white-space: pre-line;">${escapeHtml(emp.dados_pagamento)}</div>
</div>` : ''}

<div class="sign">
    <div>${escapeHtml(emp.responsavel_tecnico || 'Assinatura da empresa')}</div>
    <div>Assinatura do paciente</div>
</div>

<div class="foot">
    Este orçamento tem caráter informativo e validade de 15 dias a partir da data de emissão.
    Valores e condições sujeitos a alteração após esse período.${emp.responsavel_tecnico ? `<br>Responsável técnico: ${escapeHtml(emp.responsavel_tecnico)}` : ''}
</div>

<script>window.onload = function () { setTimeout(function () { window.print(); }, 300); };<\/script>
</body></html>`;

    const w = window.open('', '_blank');
    if (!w) { showToast('Permita pop-ups para imprimir o orçamento.', 'danger'); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
}

function cancelEditOrcamentoItem() {
    document.getElementById('orc-editing-id').value = '';
    document.getElementById('orc-procedimento').value = '';
    document.getElementById('orc-valor').value = '';
    document.getElementById('orc-desconto').value = '';
    document.getElementById('orc-forma-pagamento').value = '';
    document.getElementById('orc-condicoes').value = '';
    document.getElementById('orc-form-title').innerHTML = '<i class="fa-solid fa-plus"></i> Adicionar Procedimento';
    document.getElementById('orc-save-btn').innerHTML = '<i class="fa-solid fa-plus"></i> Adicionar Procedimento';
    document.getElementById('orc-save-btn').setAttribute('onclick', 'addOrcamentoItem()');
    document.getElementById('orc-cancel-edit-btn').style.display = 'none';
    orcUpdatePreview();
}

function editOrcamentoItem(orcId) {
    const id = document.getElementById('orc-lead-id').value;
    const lead = leads.find(l => l.id === id);
    if (!lead) return;
    const item = parseOrcamentoArray(lead.orcamento).find(i => i.id === orcId);
    if (!item) return;

    document.getElementById('orc-editing-id').value = orcId;
    document.getElementById('orc-procedimento').value = item.procedimento || '';
    document.getElementById('orc-valor').value = item.valor ? formatCurrencyBRLValue(item.valor) : '';
    document.getElementById('orc-desconto').value = item.desconto || '';
    document.getElementById('orc-forma-pagamento').value = item.formaPagamento || '';
    document.getElementById('orc-condicoes').value = item.condicoes || '';
    document.getElementById('orc-form-title').innerHTML = '<i class="fa-solid fa-pen"></i> Editar Procedimento';
    document.getElementById('orc-save-btn').innerHTML = '<i class="fa-solid fa-save"></i> Salvar Alterações';
    document.getElementById('orc-save-btn').setAttribute('onclick', 'updateOrcamentoItem()');
    document.getElementById('orc-cancel-edit-btn').style.display = 'inline-block';
    orcUpdatePreview();
    const formEl = document.querySelector('#modalOrcamento .orcx-form');
    if (formEl) formEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function addOrcamentoItem() {
    const id = document.getElementById('orc-lead-id').value;
    const procedimento = document.getElementById('orc-procedimento').value;
    // O campo mostra "1.000,00" (máscara BRL), mas é armazenado como número puro
    // ("1000.00") pra continuar compatível com todo lugar que faz parseFloat(orc.valor).
    const valor = parseCurrencyBRLInput(document.getElementById('orc-valor').value);
    const desconto = document.getElementById('orc-desconto').value;
    const formaPagamento = document.getElementById('orc-forma-pagamento').value;
    const condicoes = document.getElementById('orc-condicoes').value;
    if (!procedimento) return;

    const lead = leads.find(l => l.id === id);
    if (!lead) return;

    try {
        const res = await fetch(`/api/leads/${id}/orcamentos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ procedimento, valor, desconto, formaPagamento, condicoes })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao adicionar orçamento');

        lead.orcamento = JSON.stringify(data.items);
        lead.column = 'col-orcado';
        renderBoard();
        cancelEditOrcamentoItem();
        renderOrcamentoItemsList(id);
    } catch (e) {
        console.error('Erro ao salvar orcamento', e);
        alert(e.message || 'Erro ao adicionar orçamento');
    }
}

async function updateOrcamentoItem() {
    const id = document.getElementById('orc-lead-id').value;
    const orcId = document.getElementById('orc-editing-id').value;
    if (!orcId) return addOrcamentoItem();

    const procedimento = document.getElementById('orc-procedimento').value;
    const valor = parseCurrencyBRLInput(document.getElementById('orc-valor').value);
    const desconto = document.getElementById('orc-desconto').value;
    const formaPagamento = document.getElementById('orc-forma-pagamento').value;
    const condicoes = document.getElementById('orc-condicoes').value;

    const lead = leads.find(l => l.id === id);
    if (!lead) return;

    try {
        const res = await fetch(`/api/leads/${id}/orcamentos/${orcId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ procedimento, valor, desconto, formaPagamento, condicoes })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao editar orçamento');

        lead.orcamento = JSON.stringify(data.items);
        renderBoard();
        cancelEditOrcamentoItem();
        renderOrcamentoItemsList(id);
    } catch (e) {
        console.error('Erro ao editar orcamento', e);
        alert(e.message || 'Erro ao editar orçamento');
    }
}

async function deleteOrcamentoItem(orcId) {
    const id = document.getElementById('orc-lead-id').value;
    if (!await customConfirm('Deseja realmente excluir este procedimento orçado?', 'Excluir Orçamento')) return;

    const lead = leads.find(l => l.id === id);
    if (!lead) return;

    try {
        const res = await fetch(`/api/leads/${id}/orcamentos/${orcId}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao excluir orçamento');

        lead.orcamento = JSON.stringify(data.items);
        renderBoard();
        cancelEditOrcamentoItem();
        renderOrcamentoItemsList(id);
    } catch (e) {
        console.error('Erro ao excluir orcamento', e);
        alert(e.message || 'Erro ao excluir orçamento');
    }
}

async function deleteLead(id) {
    if(await customConfirm("Tem certeza que deseja deletar este paciente?")) {
        try {
            const res = await fetch(`/api/leads/${id}`, { method: 'DELETE' });
            const json = await res.json();
            if (json.success) {
                leads = leads.filter(l => l.id !== id);
                renderBoard();
            } else {
                await customAlert("Erro ao deletar: " + (json.error || "Desconhecido"));
            }
        } catch (e) {
            console.error("Erro ao deletar lead", e);
            await customAlert("Erro ao deletar o lead.");
        }
    }
}

// === SUGESTÕES INTELIGENTES DE AGENDAMENTO ===
function renderDayChips() {
    const container = document.getElementById('sugestoes-dias');
    if (!container) return;
    container.innerHTML = '';
    
    const today = new Date();
    for (let i = 0; i < 5; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() + i);
        // Pula domingos (opcional, mas comum em clínicas)
        if (d.getDay() === 0) {
            today.setDate(today.getDate() + 1);
            d.setDate(d.getDate() + 1);
        }
        
        const dateStr = d.toISOString().split('T')[0];
        let label = d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
        if (i === 0) label = "Hoje";
        if (i === 1) label = "Amanhã";
        
        const chip = document.createElement('div');
        chip.className = 'suggestion-chip';
        if (i === 0) chip.classList.add('active');
        chip.innerText = label;
        chip.onclick = () => {
            document.getElementById('ag-data').value = dateStr;
            document.querySelectorAll('#sugestoes-dias .suggestion-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            loadTimeSuggestions();
        };
        container.appendChild(chip);
    }
    
    // Tenta carregar horários para o dia atual automaticamente se houver profissional
    loadTimeSuggestions();
}

async function loadTimeSuggestions() {
    const doctorId = document.getElementById('ag-user').value;
    const dateStr = document.getElementById('ag-data').value;
    const container = document.getElementById('sugestoes-horas');
    const loader = document.getElementById('sugestao-loader');
    
    if (!doctorId || !dateStr || !container) {
        if(container) container.style.display = 'none';
        return;
    }
    
    container.style.display = 'flex';
    container.innerHTML = '';
    loader.style.display = 'block';
    
    try {
        const res = await fetch(`/api/availability?user_id=${doctorId}&date=${dateStr}`);
        const data = await res.json();
        
        loader.style.display = 'none';
        
        if (data.slots && data.slots.length > 0) {
            data.slots.forEach(time => {
                const chip = document.createElement('div');
                chip.className = 'suggestion-chip';
                chip.innerText = time;
                chip.onclick = () => {
                    document.getElementById('ag-hora').value = time;
                    document.querySelectorAll('#sugestoes-horas .suggestion-chip').forEach(c => c.classList.remove('active'));
                    chip.classList.add('active');
                };
                container.appendChild(chip);
            });
        } else {
            container.innerHTML = '<span style="font-size: 0.8rem; color: var(--accent-danger);">Nenhum horário livre</span>';
        }
    } catch (e) {
        loader.style.display = 'none';
        container.innerHTML = '<span style="font-size: 0.8rem; color: var(--text-muted);">Erro ao carregar</span>';
    }
}

// Escutar mudanças nos selects nativos
document.addEventListener('DOMContentLoaded', () => {
    const agUser = document.getElementById('ag-user');
    const agData = document.getElementById('ag-data');
    if(agUser) agUser.addEventListener('change', loadTimeSuggestions);
    if(agData) agData.addEventListener('change', loadTimeSuggestions);
});

// === INTEGRAÇÃO COM A VERCEL (QUE FALA COM AMIGO APP) ===
function resetAgendamentoForm() {
    window.selectedPatientId = null;
    // Sem isso, depois da primeira edição de um atendimento existente na sessão,
    // todo agendamento novo seguinte era tratado como edição (isNewAppointment
    // ficava sempre false) e o confete de comemoração parava de disparar.
    window.currentEditingAttendanceId = null;
    window.currentEditingAttendance = null;
    const idsToClear = [
        'ag-lead-id', 'ag-place', 'ag-user', 'ag-event', 'ag-event-search',
        'ag-patient-name', 'ag-patient-phone', 'ag-patient-email', 'ag-patient-born'
    ];
    idsToClear.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const confirmBtn = document.querySelector('#integrationActions .btn-save');
    if (confirmBtn) confirmBtn.innerText = "Enviar para o Amigo App →";
}

function openAgendamentoModal(cardId) {
    const lead = leads.find(l => l.id === cardId);
    if (!lead) return;
    
    resetAgendamentoForm();
    
    draggedLead = lead; // Configura o lead ativo do Kanban
    
    document.getElementById('ag-lead-id').value = cardId;
    document.getElementById('ag-data').value = new Date().toISOString().split('T')[0]; // Hoje
    
    document.getElementById('directScheduleFields').style.display = 'none';
    
    renderDayChips(); // Iniciar sugestões
    
    document.getElementById('modalAgendamento').classList.add('active');
}

function openGridScheduleModal(doctorId, time) {
    resetAgendamentoForm();
    draggedLead = null; // Não há lead ativo, agendamento direto
    
    // Mostra os campos de nome/telefone
    document.getElementById('directScheduleFields').style.display = 'block';
    
    // Preenche a data, hora e profissional
    document.getElementById('ag-data').value = currentAgendaDate;
    document.getElementById('ag-hora').value = time;
    
    const docSelect = document.getElementById('ag-user');
    if (docSelect) docSelect.value = doctorId;
    
    renderDayChips(); // Iniciar sugestões
    
    document.getElementById('modalAgendamento').classList.add('active');
}

function closeAgendamentoModal() {
    document.getElementById('modalAgendamento').classList.remove('active');
}

function cancelAgendamento() {
    closeAgendamentoModal();
}

window.currentEditingAttendanceId = null;
window.currentEditingAttendance = null;

function openPatientDetailsModal(attId, event) {
    if (event) event.stopPropagation(); // Previne o clique na grid-cell por baixo
    
    if (!window.currentAgendaAttendances) return;
    
    const att = window.currentAgendaAttendances.find(a => String(a.id) === String(attId));
    if (!att) return;
    
    window.currentEditingAttendance = att;
    window.currentEditingAttendanceId = att.id;
    
    document.getElementById('pd-name').innerText = (att.patient && att.patient.name) ? att.patient.name : 'Desconhecido';
    
    let phone = '-';
    let waLink = '#';
    if (att.patient && att.patient.contact_cellphone) {
        phone = att.patient.contact_cellphone;
        // Clean non-digits
        const rawPhone = phone.replace(/\D/g, '');
        waLink = `https://wa.me/55${rawPhone}`;
        
        // Tenta formatar telefone BR se tiver 11 digitos
        if (phone.length === 11) {
            phone = `(${phone.substring(0,2)}) ${phone.substring(2,7)}-${phone.substring(7,11)}`;
        }
    }
    
    const phoneEl = document.getElementById('pd-phone');
    phoneEl.innerText = phone;
    if (phone !== '-') {
        phoneEl.href = waLink;
        phoneEl.target = "_blank";
        phoneEl.style.color = "var(--accent-success)";
        phoneEl.style.textDecoration = "none";
        phoneEl.innerHTML = `<i class="fa-brands fa-whatsapp"></i> ${phone}`;
    } else {
        phoneEl.removeAttribute('href');
        phoneEl.style.color = "inherit";
        phoneEl.innerHTML = phone;
    }
    
    document.getElementById('pd-service').innerText = (att.agenda_event && att.agenda_event.name) ? att.agenda_event.name : '-';
    document.getElementById('pd-doctor').innerText = (att.user && att.user.name) ? att.user.name : '-';
    document.getElementById('pd-obs').innerText = att.observation || 'Sem observações/origem';
    
    document.getElementById('modalPatientDetails').classList.add('active');
}

function closePatientDetailsModal() {
    document.getElementById('modalPatientDetails').classList.remove('active');
}

function openEditAgendamentoModal() {
    // Guardamos antes: resetAgendamentoForm() abaixo zera estes globais, e o
    // fluxo de edição precisa deles (senão att fica null e o PUT vira POST/duplicata).
    const att = window.currentEditingAttendance;
    const attId = window.currentEditingAttendanceId;
    if (!att) return;

    if (typeof loggedUser === 'undefined' || !loggedUser || loggedUser.role !== 'admin') {
        customAlert("Apenas administradores podem editar o histórico de agendamento.");
        return;
    }

    closePatientDetailsModal();
    resetAgendamentoForm();

    // Restaura o alvo da edição que o reset acabou de limpar.
    window.currentEditingAttendance = att;
    window.currentEditingAttendanceId = attId;

    draggedLead = null;
    document.getElementById('ag-lead-id').value = '';
    document.getElementById('directScheduleFields').style.display = 'block';
    
    if(att.start_date) {
        try {
            const parts = att.start_date.split('T');
            if (parts.length === 2) {
                document.getElementById('ag-data').value = parts[0];
                document.getElementById('ag-hora').value = parts[1].substring(0,5);
            }
        } catch(e) {}
    }
    
    document.getElementById('ag-patient-name').value = (att.patient && att.patient.name) ? att.patient.name.replace(' [MKT]','') : '';
    document.getElementById('ag-patient-phone').value = (att.patient && att.patient.contact_cellphone) ? att.patient.contact_cellphone : '';
    
    const docSelect = document.getElementById('ag-user');
    if (docSelect && att.user) docSelect.value = att.user.id;
    
    const eventHidden = document.getElementById('ag-event');
    if (eventHidden && att.agenda_event) eventHidden.value = att.agenda_event.id;
    
    const eventSearch = document.getElementById('ag-event-search');
    if (eventSearch && att.agenda_event) eventSearch.value = att.agenda_event.name;
    
    const placeSelect = document.getElementById('ag-place');
    if (placeSelect && att.place) placeSelect.value = att.place.id;
    
    const confirmBtn = document.querySelector('#integrationActions .btn-save');
    if (confirmBtn) confirmBtn.innerText = "Atualizar no Amigo App →";
    
    document.getElementById('modalAgendamento').classList.add('active');
}

async function confirmAgendamento() {
    // Guardado antes do fetch: window.currentEditingAttendanceId é zerado no sucesso,
    // então precisamos saber agora se isso é um agendamento novo (celebra) ou edição (não celebra).
    const isNewAppointment = !window.currentEditingAttendanceId;

    const dataAg = document.getElementById('ag-data').value;
    const horaAg = document.getElementById('ag-hora').value;
    const placeId = document.getElementById('ag-place').value;
    const doctorId = document.getElementById('ag-user').value;
    const procedureId = document.getElementById('ag-event').value;
    
    if(!dataAg || !horaAg || !placeId || !doctorId || !procedureId) {
        await customAlert("Preencha todos os campos do agendamento!");
        return;
    }
    
    let leadName = "";
    let leadPhone = "";
    let leadEmail = "";
    let patientBorn = "1990-01-01"; // Default exigido
    
    let fbClickId = '';
    
    if (draggedLead) {
        // Veio do Kanban
        leadName = draggedLead.nome;
        leadPhone = draggedLead.telefone;
        leadEmail = draggedLead.email || '';
        fbClickId = draggedLead.fb_click_id || '';
        if (draggedLead.born) patientBorn = draggedLead.born;
        if (draggedLead.nascimento) patientBorn = draggedLead.nascimento;
    } else {
        // Veio direto da grade
        leadName = document.getElementById('ag-patient-name').value;
        leadPhone = document.getElementById('ag-patient-phone').value;
        leadEmail = (document.getElementById('ag-patient-email') || {}).value || '';
        const bornVal = (document.getElementById('ag-patient-born') || {}).value || '';
        if (bornVal) patientBorn = bornVal;
        if (!leadName) {
            await customAlert("Preencha o nome do paciente!");
            return;
        }
    }
    
    const selPlace = document.getElementById('ag-place');
    const placeName = selPlace.options[selPlace.selectedIndex]?.text || '';
    
    const procedureName = document.getElementById('ag-event-search').value || '';
    const valor1 = document.getElementById('ag-valor1').value || '0.00';
    const valor2 = document.getElementById('ag-valor2').value || '0.00';
    const statusPag = document.getElementById('ag-status-pag').value;
    const origemVal = document.getElementById('ag-origem').value;
    const agendadoPor = (typeof loggedUser !== 'undefined' && loggedUser && loggedUser.username) ? loggedUser.username : 'Desconhecido';

    const payload = {
        lead_id: document.getElementById('ag-lead-id')?.value || (draggedLead ? draggedLead.id : null),
        appointment_date: dataAg,
        appointment_time: horaAg,
        place_id: placeId,
        place_name: placeName,
        user_id: doctorId,
        event_id: procedureId,
        procedure_name: procedureName,
        patient_name: leadName,
        patient_phone: leadPhone,
        patient_email: leadEmail,
        patient_born: patientBorn,
        fb_click_id: fbClickId,
        valor_primario: valor1,
        valor_secundario: valor2,
        status_pagamento: statusPag,
        origem: origemVal,
        agendado_por: agendadoPor,
        attendance_id: window.currentEditingAttendanceId,
        patient_id: window.selectedPatientId,
        unidade_id: typeof getSelectedUnidadeId === 'function' ? getSelectedUnidadeId() : undefined
    };
    
    const loader = document.getElementById('integrationLoader');
    loader.classList.add('active');
    
    try {
        const response = await fetch('/api/agendar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        const result = await response.json();
        
        if (!response.ok) {
            throw new Error(result.error || "Erro desconhecido na API do Amigo App");
        }
        
        if (isNewAppointment) celebrateAgendamento();
        await customAlert("Agendamento criado com sucesso no Amigo App!");

        if (draggedLead) {
            draggedLead.column = 'col-agendado';
            renderBoard();
            updateLeadColumnOnServer(draggedLead.id, 'col-agendado');
        } else {
            // Se foi direto da agenda, atualizar a grade
            renderAgendaGrid();
        }
        closePatientDetailsModal();
        closeAgendamentoModal();
        
        // Reseta o botão de confirmação e id
        const confirmBtn = document.querySelector('#integrationActions .btn-save');
        if (confirmBtn) confirmBtn.innerText = "Enviar para o Amigo App →";
        window.currentEditingAttendanceId = null;
        window.currentEditingAttendance = null;
        
        // Atualiza dashboard em segundo plano após o agendamento
        fetchLeadsFromServer(true).then(() => renderDashboard());
    } catch (error) {
        console.error("Erro ao agendar/atualizar:", error);
        await customAlert(error.message);
    } finally {
        loader.classList.remove('active');
    }
}

function exportarCSVFinanceiro() {
    // Acompanha o toggle da tela: por padrão só os agendamentos deste sistema.
    const incluirAmigo = document.getElementById('filtro-incluir-amigo')?.checked;
    window.location.href = '/api/export-csv' + (incluirAmigo ? '?only_local=0' : '');
}

// === NAVEGAÇÃO DE ABAS ===
// Flyouts horizontais da sidebar (Relacionamento, Campanhas) — reparentados
// pro body porque a sidebar tem overflow-y:auto, que corta (clipa) qualquer
// filho que ultrapasse sua borda direita (mesmo problema já resolvido no sino
// de notificações). Genérico o bastante pra qualquer novo flyout de menu.
let sidebarFlyoutCloseTimers = {};

function openSidebarFlyout(flyoutId, triggerId) {
    cancelCloseSidebarFlyout(flyoutId);
    const flyout = document.getElementById(flyoutId);
    const trigger = document.getElementById(triggerId);
    if (!flyout || !trigger) return;

    if (flyout.parentElement !== document.body) {
        document.body.appendChild(flyout);
    }

    const rect = trigger.getBoundingClientRect();
    const gap = 10;
    const sidebar = trigger.closest('header');
    // Mantém a sidebar aberta enquanto o flyout estiver visível — evita o
    // "buraco" entre a barra recolhida e o flyout ao mover o mouse.
    if (sidebar) sidebar.classList.add('sb-flyout-open');
    // Ancora SEMPRE na borda da sidebar já expandida (232px = CSS
    // header.sb-collapsed:hover { width: 232px }). Não medir getBoundingClientRect
    // da sidebar aqui: a largura está em transição e mediria um valor menor,
    // jogando o flyout por cima do menu.
    const EXPANDED_SIDEBAR_W = 232;
    const sidebarLeft = sidebar ? sidebar.getBoundingClientRect().left : 0;
    const measuredRight = sidebar ? sidebar.getBoundingClientRect().right : rect.right;
    // usa o maior entre a largura-alvo e a medida atual — nunca sob a barra
    const anchorRight = Math.max(sidebarLeft + EXPANDED_SIDEBAR_W, measuredRight);
    flyout.style.left = Math.round(anchorRight + gap) + 'px';
    flyout.style.top = Math.round(rect.top) + 'px';
    flyout.style.display = 'flex';
    flyout.style.flexDirection = 'column';
    // Acima da sidebar (que fica em z-index 10000 quando expandida no hover).
    flyout.style.zIndex = '10001';

    // Reinicia a animação de abertura toda vez (remove + força reflow + adiciona de novo).
    flyout.classList.remove('sb-flyout-visible');
    void flyout.offsetWidth;
    flyout.classList.add('sb-flyout-visible');

    requestAnimationFrame(() => {
        const overflowBottom = flyout.getBoundingClientRect().bottom - window.innerHeight;
        if (overflowBottom > 0) {
            flyout.style.top = Math.max(8, rect.top - overflowBottom - 8) + 'px';
        }
    });
}

function scheduleCloseSidebarFlyout(flyoutId) {
    cancelCloseSidebarFlyout(flyoutId);
    sidebarFlyoutCloseTimers[flyoutId] = setTimeout(() => {
        const flyout = document.getElementById(flyoutId);
        if (flyout) flyout.style.display = 'none';
        releaseSidebarFlyoutPin();
    }, 250);
}

// Só solta a sidebar quando NENHUM flyout de submenu está visível.
function releaseSidebarFlyoutPin() {
    const anyOpen = ['relacionamento-flyout', 'campanhas-flyout'].some(fid => {
        const f = document.getElementById(fid);
        return f && f.style.display && f.style.display !== 'none';
    });
    if (!anyOpen) {
        const header = document.querySelector('header');
        if (header) header.classList.remove('sb-flyout-open');
    }
}

function cancelCloseSidebarFlyout(flyoutId) {
    if (sidebarFlyoutCloseTimers[flyoutId]) {
        clearTimeout(sidebarFlyoutCloseTimers[flyoutId]);
        sidebarFlyoutCloseTimers[flyoutId] = null;
    }
}

// Wrappers (mantêm os nomes já usados nos onmouseenter/onmouseleave existentes)
function openRelacionamentoFlyout() { openSidebarFlyout('relacionamento-flyout', 'tab-relacionamento-main'); }
function scheduleCloseRelacionamentoFlyout() { scheduleCloseSidebarFlyout('relacionamento-flyout'); }
function cancelCloseRelacionamentoFlyout() { cancelCloseSidebarFlyout('relacionamento-flyout'); }

function openCampanhasFlyout() { openSidebarFlyout('campanhas-flyout', 'tab-campanhas-main'); }
function scheduleCloseCampanhasFlyout() { scheduleCloseSidebarFlyout('campanhas-flyout'); }
function cancelCloseCampanhasFlyout() { cancelCloseSidebarFlyout('campanhas-flyout'); }

function switchTab(tabId) {
    if (window.closeAllAirDatepickers) window.closeAllAirDatepickers();
    const relFlyout = document.getElementById('relacionamento-flyout');
    if (relFlyout) relFlyout.style.display = 'none';
    const campFlyout = document.getElementById('campanhas-flyout');
    if (campFlyout) campFlyout.style.display = 'none';
    const sbHeader = document.querySelector('header');
    if (sbHeader) sbHeader.classList.remove('sb-flyout-open');

    const tabTitles = {
        kanban: 'CRM Vendas',
        agenda: 'Agenda Completa',
        chat: 'Atendimento',
        dashboard: 'Dashboard',
        campanhas: 'Campanhas',
        'origem-leads': 'UTMs',
        posvenda: 'Pós-Venda',
        faltantes: 'Faltantes',
        sumidos: 'Sumidos',
        aniversariantes: 'Aniversariantes',
        contatos: 'Contatos',
        fluxos: 'Fluxos',
        midias: 'Mídias',
        historico: 'Financeiro',
    };
    if (tabTitles[tabId]) document.title = 'BioFlow — ' + tabTitles[tabId];

    if (tabId === 'historico') {
        if (!window.location.pathname.includes('historico.html')) {
            window.location.href = 'historico.html';
        }
        return;
    }
    
    if (window.location.pathname.includes('historico.html')) {
        window.location.href = 'index.html';
        return;
    }

    // Trocar de aba pelo menu fecha a ficha do lead — senão a página dedicada
    // (position:fixed, z-index alto) fica cobrindo a view nova.
    if (typeof closeLeadProfile === 'function') closeLeadProfile();

    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    
    // Ativa o botão da aba atual
    const btn = document.querySelector(`[onclick="switchTab('${tabId}')"]`);
    if(btn) btn.classList.add('active');
    
    // Se for uma sub-aba de relacionamento, manter o dropdown 'pai' ativo também
    if (['posvenda', 'faltantes', 'sumidos', 'aniversariantes'].includes(tabId)) {
        const mainRelBtn = document.getElementById('tab-relacionamento-main');
        if (mainRelBtn) mainRelBtn.classList.add('active');
    }
    // Idem pro dropdown "Campanhas" (Disparo de Mensagens / UTMs)
    if (['campanhas', 'origem-leads'].includes(tabId)) {
        const mainCampBtn = document.getElementById('tab-campanhas-main');
        if (mainCampBtn) mainCampBtn.classList.add('active');
    }
    
    document.getElementById('view-kanban').style.display = 'none';
    document.getElementById('view-agenda').style.display = 'none';
    const chatView = document.getElementById('view-chat');
    if(chatView) chatView.style.display = 'none';
    const dashView = document.getElementById('view-dashboard');
    if(dashView) dashView.style.display = 'none';
    const campView = document.getElementById('view-campanhas');
    if(campView) campView.style.display = 'none';
    const origemView = document.getElementById('view-origem-leads');
    if(origemView) origemView.style.display = 'none';
    const contatosView = document.getElementById('view-contatos');
    if(contatosView) contatosView.style.display = 'none';
    const fluxosView = document.getElementById('view-fluxos');
    if(fluxosView) fluxosView.style.display = 'none';
    const midiasView = document.getElementById('view-midias');
    if(midiasView) midiasView.style.display = 'none';

    // Para polling do chat ao sair da aba
    if (tabId !== 'chat' && window.chatPollingInterval) {
        clearInterval(window.chatPollingInterval);
        window.chatPollingInterval = null;
    }
    
    // Para polling do dashboard ao sair da aba
    if (tabId !== 'dashboard' && window.dashPollingInterval) {
        clearInterval(window.dashPollingInterval);
        window.dashPollingInterval = null;
    }
    
    ['posvenda', 'faltantes', 'sumidos', 'aniversariantes'].forEach(t => {
        const el = document.getElementById(`view-${t}`);
        if(el) el.style.display = 'none';
    });
    
    if(tabId === 'kanban') {
        document.getElementById('view-kanban').style.display = 'flex';
    } else if (tabId === 'dashboard') {
        const view = document.getElementById('view-dashboard');
        if (view) view.style.display = 'flex';
        if (!window.dashServerDefaultLoaded) {
            window.dashServerDefaultLoaded = true;
            // Precisa terminar ANTES de montar o layout na primeira vez — senão
            // quem nunca personalizou o próprio dashboard veria o arranjo de
            // fábrica piscar antes do padrão do servidor chegar.
            loadServerDashboardDefault().then(initializeDashboardCustomizer);
        } else {
            initializeDashboardCustomizer();
        }
        if (!window.dashGoalLoaded) {
            window.dashGoalLoaded = true;
            loadDashboardGoal().then(renderDashboard);
        }
        loadDashboardResponseMetrics().then(renderDashboard);
        renderDashboard(); // Render charts and metrics
        // Inicia auto-refresh a cada 60s enquanto o dashboard estiver aberto
        // (era 10s, depois 30s — puxava a lista de leads + métricas de resposta,
        // ambas scans; dashboard é visão gerencial, não precisa de 30s de frescor).
        if (!window.dashPollingInterval) {
            window.dashPollingInterval = setInterval(async () => {
                if (document.getElementById('view-dashboard')?.style.display !== 'none') {
                    await fetchLeadsFromServer(true);
                    await loadDashboardResponseMetrics();
                    renderDashboard();
                }
            }, 60000);
        }
    } else if (tabId === 'campanhas') {
        const view = document.getElementById('view-campanhas');
        if (view) view.style.display = 'flex';
        if (typeof switchDispatchTab === 'function') switchDispatchTab('new');
        loadWhatsappTemplates();
        loadAudiences().then(updateCampaignLeadCount);
        loadDispatchHistory();
        const pricingBtn = document.getElementById('btn-whatsapp-pricing');
        const isAdmin = typeof loggedUser !== 'undefined' && loggedUser && (loggedUser.role === 'admin' || loggedUser.username === 'admin');
        if (pricingBtn) pricingBtn.style.display = isAdmin ? 'inline-flex' : 'none';
    } else if (tabId === 'origem-leads') {
        const view = document.getElementById('view-origem-leads');
        if (view) view.style.display = 'flex';
        if (typeof switchUtmTab === 'function') switchUtmTab('overview');
        if (typeof loadCampaigns === 'function') loadCampaigns();
    } else if (tabId === 'agenda') {
        document.getElementById('view-agenda').style.display = 'flex';
        renderAgendaGrid();
    } else if (tabId === 'contatos') {
        const view = document.getElementById('view-contatos');
        if (view) {
            view.style.display = 'flex';
            loadContatos();
        }
    } else if (tabId === 'chat') {
        if (typeof hideChatNotificationDot === 'function') hideChatNotificationDot();
        const view = document.getElementById('view-chat');
        if (view) {
            view.style.display = 'flex';
            loadChats();
            // Inicia polling se ainda não estiver rodando. A lista de conversas
            // (loadChats) é a consulta mais cara do sistema — agora que mensagem
            // nova chega por SSE (evento wa_message), o poll dela virou só rede
            // de segurança e vai a ~90s. A conversa ABERTA (openChat refresh) é
            // barata (filtra por telefone) e segue rápida, a cada 6s.
            if (!window.chatPollingInterval) {
                let chatTick = 0;
                window.chatPollingInterval = setInterval(() => {
                    if (document.getElementById('view-chat').style.display === 'none') return;
                    chatTick++;
                    if (window.currentActiveChat) {
                        openChat(window.currentActiveChat.phone, window.currentActiveChat.name, true);
                    }
                    if (chatTick % 15 === 1) {
                        loadChats(true);
                    }
                }, 6000);
            }
        }
    } else if (tabId === 'fluxos') {
        const view = document.getElementById('view-fluxos');
        if (view) {
            view.style.display = 'flex';
            if (typeof loadFlows === 'function') loadFlows();
        }
    } else if (tabId === 'midias') {
        const view = document.getElementById('view-midias');
        if (view) {
            view.style.display = 'flex';
            if (typeof loadMidias === 'function') loadMidias(null);
        }
    } else if (['posvenda', 'faltantes', 'sumidos', 'aniversariantes'].includes(tabId)) {
        const view = document.getElementById(`view-${tabId}`);
        if (view) {
            view.style.display = 'flex';
            // A barra de disparo em massa dessas telas precisa da lista de templates
            // aprovados — sem isso, quem nunca abriu a aba Campanhas via checkbox
            // "vazio" mesmo tendo templates disponíveis.
            if (typeof loadWhatsappTemplates === 'function' && cachedWhatsappTemplates.length === 0) {
                loadWhatsappTemplates();
            }
            if (tabId === 'aniversariantes') {
                fetchAniversariantesHoje();
                fetchAniversariantesMes();
            } else {
                fetchRelacionamento();
            }
        }
    }

    const incomingView = document.getElementById(`view-${tabId}`);
    if (incomingView) {
        incomingView.classList.remove('is-entering');
        void incomingView.offsetWidth;
        incomingView.classList.add('is-entering');
        incomingView.addEventListener('animationend', () => incomingView.classList.remove('is-entering'), { once: true });
    }
}

// === BASE DE CONTATOS (todo mundo que já falou com a clínica no WhatsApp) ===
// A fonte é /api/contacts (agregado da tabela wa_messages). O nome, a origem e a
// etapa no funil vêm do array "leads" já carregado — todo contato de WhatsApp
// vira um lead automaticamente no webhook, então o cruzamento por telefone cobre
// praticamente 100% dos casos.
let contatosData = [];
let contatosLoaded = false;

async function loadContatos(force = false) {
    const tbody = document.getElementById('list-contatos');
    if (!tbody) return;
    if (contatosLoaded && !force) { renderContatos(); return; }

    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:2rem; color:var(--text-muted);"><span class="amicro-loader"><span></span><span></span><span></span></span> Carregando contatos...</td></tr>`;

    try {
        if (!Array.isArray(leads) || leads.length === 0) {
            await fetchLeadsFromServer(true);
        }
        const res = await fetch('/api/contacts');
        const json = await res.json();
        const rows = json.success ? (json.data || []) : [];

        const mergedRows = [];
        for (const row of rows) {
            if (!row.phone) continue;
            const existing = mergedRows.find(r => typeof isSamePhone === 'function' && isSamePhone(r.phone, row.phone));
            if (existing) {
                existing.total_messages += Number(row.total_messages || 0);
                existing.inbound_count += Number(row.inbound_count || 0);
                if (row.first_contact && (!existing.first_contact || row.first_contact < existing.first_contact)) {
                    existing.first_contact = row.first_contact;
                }
                if (row.last_contact && (!existing.last_contact || row.last_contact > existing.last_contact)) {
                    existing.last_contact = row.last_contact;
                }
                if (String(row.phone).length > String(existing.phone).length) {
                    existing.phone = row.phone;
                }
            } else {
                mergedRows.push({
                    phone: row.phone,
                    first_contact: row.first_contact,
                    last_contact: row.last_contact,
                    total_messages: Number(row.total_messages || 0),
                    inbound_count: Number(row.inbound_count || 0)
                });
            }
        }

        contatosData = mergedRows.map(row => {
            const lead = (Array.isArray(leads) ? leads : []).find(l => typeof isSamePhone === 'function' && isSamePhone(l.telefone, row.phone));
            return {
                phone: row.phone,
                nome: (lead && lead.nome) ? lead.nome : 'Lead WhatsApp',
                origem: (lead && lead.origem) ? lead.origem : '',
                column: lead ? (lead.column || lead.column_id) : null,
                email: (lead && lead.email) ? lead.email : '',
                leadId: lead ? lead.id : null,
                first_contact: row.first_contact,
                last_contact: row.last_contact,
                total_messages: Number(row.total_messages || 0),
                inbound_count: Number(row.inbound_count || 0),
            };
        });
        contatosLoaded = true;
        renderContatos();
    } catch (e) {
        console.error('Erro ao carregar contatos:', e);
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:2rem; color:var(--accent-danger);">Falha ao carregar a base de contatos.</td></tr>`;
    }
}

function fmtContatoDate(raw) {
    if (!raw) return '—';
    // O backend grava em UTC sem marcador de fuso (ISO da Meta / CURRENT_TIMESTAMP).
    // Marca como UTC pra o toLocale* converter pro horário local do navegador.
    let s = String(raw).trim().replace(' ', 'T');
    if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
    const d = new Date(s);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function renderContatos() {
    const tbody = document.getElementById('list-contatos');
    const countEl = document.getElementById('count-contatos');
    if (!tbody) return;

    const q = (document.getElementById('contatos-search')?.value || '').trim().toLowerCase();
    let rows = contatosData;
    if (q) {
        rows = rows.filter(r =>
            (r.nome || '').toLowerCase().includes(q) ||
            String(r.phone || '').toLowerCase().includes(q) ||
            formatPhone(r.phone).toLowerCase().includes(q)
        );
    }
    if (countEl) countEl.textContent = rows.length;

    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:2rem; color:var(--text-muted);">Nenhum contato encontrado.</td></tr>`;
        return;
    }

    tbody.innerHTML = rows.map(r => {
        const col = KANBAN_COLUMNS[r.column];
        const etapa = col
            ? `<span style="display:inline-flex; align-items:center; gap:0.35rem; font-size:0.8rem; color:${col.color};"><i class="fa-solid ${col.icon}" style="font-size:0.7rem;"></i> ${col.label}</span>`
            : `<span style="color:var(--text-muted);">—</span>`;
        const nomeSafe = escapeHtml(r.nome || 'Lead WhatsApp');
        const phoneJs = String(r.phone || '').replace(/'/g, "\\'");
        const nomeJs = nomeSafe.replace(/'/g, "\\'");
        const leadIdJs = r.leadId ? String(r.leadId).replace(/'/g, "\\'") : '';
        const rowClickable = !!r.leadId;
        return `
        <tr ${rowClickable ? `onclick="openLeadProfile('${leadIdJs}')" style="cursor:pointer;" title="Ver ficha completa do paciente"` : ''}>
            <td style="font-weight:500;">
                <div style="display:flex; align-items:center; gap:0.75rem;">
                    <div style="width:32px; height:32px; border-radius:50%; background:rgba(59,130,246,0.1); display:flex; align-items:center; justify-content:center; color:var(--accent-primary); flex-shrink:0;">
                        <i class="fa-solid fa-user"></i>
                    </div>
                    ${nomeSafe}
                </div>
            </td>
            <td>${formatPhone(r.phone)}</td>
            <td style="color:var(--text-muted);">${escapeHtml(r.origem || '—')}</td>
            <td>${etapa}</td>
            <td>${fmtContatoDate(r.first_contact)}</td>
            <td>${fmtContatoDate(r.last_contact)}</td>
            <td style="text-align:center;">${r.total_messages}<br><small style="color:var(--text-muted);">${r.inbound_count} recebidas</small></td>
            <td style="text-align:center;">
                <button class="btn-secondary" onclick="event.stopPropagation(); abrirConversaContato('${phoneJs}', '${nomeJs}')"
                    style="width:100%; justify-content:center; background:rgba(16,185,129,0.15); color:var(--accent-success); border-color:rgba(16,185,129,0.3); padding:0.5rem;">
                    <i class="fa-brands fa-whatsapp"></i> Abrir conversa
                </button>
            </td>
        </tr>`;
    }).join('');
}

function filterContatos() {
    renderContatos();
}

function abrirConversaContato(phone, name) {
    switchTab('chat');
    setTimeout(() => {
        if (typeof openChat === 'function') openChat(phone, name);
    }, 150);
}

function exportContatosCSV() {
    if (!contatosData.length) {
        alert('Nenhum contato para exportar.');
        return;
    }
    const header = ['Nome', 'Telefone', 'Origem', 'Etapa', 'Primeiro contato', 'Ultimo contato', 'Total mensagens', 'Recebidas'];
    const esc = v => {
        const s = String(v ?? '').replace(/"/g, '""');
        return /[",\n;]/.test(s) ? `"${s}"` : s;
    };
    const lines = [header.join(',')];
    contatosData.forEach(r => {
        const col = KANBAN_COLUMNS[r.column];
        lines.push([
            r.nome || '', r.phone || '', r.origem || '', col ? col.label : '',
            fmtContatoDate(r.first_contact), fmtContatoDate(r.last_contact),
            r.total_messages, r.inbound_count
        ].map(esc).join(','));
    });
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `contatos-whatsapp-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

// === RELACIONAMENTO (CRM ATIVO) ===
let relacionamentoFetched = false;

async function fetchRelacionamento() {
    if (relacionamentoFetched) return; // Só busca a primeira vez
    
    try {
        const res = await fetch('/api/relacionamento');
        if (!res.ok) throw new Error("Erro ao buscar dados de relacionamento");
        const data = await res.json();
        
        renderRelacionamentoList('posvenda', data.pos_venda, renderPosVendaCard);
        renderRelacionamentoList('faltantes', data.faltantes, renderFaltantesCard);
        renderRelacionamentoList('sumidos', data.sumidos, renderSumidosCard);
        
        relacionamentoFetched = true;
    } catch (e) {
        console.error(e);
        const errHtml = `<div style="color: var(--accent-danger); text-align: center; padding: 2rem;">Falha ao carregar dados.</div>`;
        document.getElementById('list-posvenda').innerHTML = errHtml;
        document.getElementById('list-faltantes').innerHTML = errHtml;
        document.getElementById('list-sumidos').innerHTML = errHtml;
    }
}

function renderRelacionamentoList(idSuffix, list, cardRenderer) {
    const countEl = document.getElementById(`count-${idSuffix}`);
    if (countEl) countEl.innerText = list.length;

    const container = document.getElementById(`list-${idSuffix}`);
    resetRelBulkBar(idSuffix);

    if (list.length === 0) {
        container.innerHTML = `<div style="color: var(--text-muted); text-align: center; grid-column: 1 / -1; margin-top: 2rem;">Nenhum paciente encontrado.</div>`;
        return;
    }

    container.innerHTML = list.map(item => cardRenderer(item)).join('');
}

// === SELEÇÃO EM MASSA + DISPARO DE CAMPANHA PARA AS LISTAS DE RELACIONAMENTO ===
// tipo (id usado no DOM/checkboxes) -> tipo aceito por /api/mensagens (paciente_id/tipo).
// "posvenda" (sem underscore, por causa do id-suffix já usado no HTML) vira "pos_venda"
// (com underscore, o valor histórico gravado no banco); aniversariantes-hoje/mes viram
// o mesmo "aniversariante" já usado por getWhatsAppLink.
const REL_TIPO_TO_BACKEND = {
    posvenda: 'pos_venda',
    faltantes: 'faltantes',
    sumidos: 'sumidos',
    'aniversariantes-hoje': 'aniversariante',
    'aniversariantes-mes': 'aniversariante'
};

function resetRelBulkBar(tipo) {
    const bar = document.getElementById(`rel-bulk-bar-${tipo}`);
    if (!bar) return;
    bar.style.display = 'none';
    bar.innerHTML = '';
    delete bar.dataset.built;
}

function getRelSelectedRecipients(tipo) {
    const boxes = document.querySelectorAll(`.rel-select[data-tipo="${tipo}"]:checked`);
    return Array.from(boxes).map(cb => ({
        id: cb.dataset.id,
        nome: cb.dataset.nome,
        telefone: cb.dataset.telefone
    }));
}

function toggleRelSelectAll(tipo, checked) {
    document.querySelectorAll(`.rel-select[data-tipo="${tipo}"]`).forEach(cb => { cb.checked = checked; });
    updateRelBulkBar(tipo);
}

// As caixinhas de seleção ficam escondidas por padrão (coluna .rel-select-col
// com display:none) — só aparecem depois que o atendente clica em "Selecionar
// para Disparo", pra não poluir a lista quando o objetivo é só ver quem está
// naquela lista, não necessariamente disparar mensagem.
function toggleRelSelectMode(tipo, btn) {
    const table = document.getElementById(`rel-table-${tipo}`);
    if (!table) return;
    const active = table.classList.toggle('rel-selecting');

    if (!active) {
        document.querySelectorAll(`.rel-select[data-tipo="${tipo}"]`).forEach(cb => { cb.checked = false; });
        const headerCheckbox = table.querySelector('thead input[type="checkbox"]');
        if (headerCheckbox) headerCheckbox.checked = false;
        updateRelBulkBar(tipo);
    }

    btn.classList.toggle('active', active);
    btn.innerHTML = active
        ? '<i class="fa-solid fa-xmark"></i> Cancelar Seleção'
        : '<i class="fa-regular fa-square-check"></i> Selecionar para Disparo';
}

function updateRelBulkBar(tipo) {
    const bar = document.getElementById(`rel-bulk-bar-${tipo}`);
    if (!bar) return;
    const count = document.querySelectorAll(`.rel-select[data-tipo="${tipo}"]:checked`).length;

    if (count === 0) {
        resetRelBulkBar(tipo);
        return;
    }

    bar.style.display = 'flex';
    // Só (re)monta o select/botões na primeira vez que a barra aparece — senão o
    // template escolhido pelo atendente seria perdido a cada novo checkbox clicado.
    if (!bar.dataset.built) {
        const approved = (cachedWhatsappTemplates || []).filter(t => t.status === 'APPROVED');
        const options = approved.length
            ? approved.map(t => `<option value="${escapeHtml(t.name)}|${escapeHtml(t.language)}">${escapeHtml(t.name)} (${escapeHtml(t.language)})</option>`).join('')
            : '<option value="">Nenhum template aprovado ainda</option>';
        bar.innerHTML = `
            <span class="rel-bulk-count" style="font-weight: 600; white-space: nowrap;"></span>
            <select class="form-control" id="rel-bulk-template-${tipo}" style="flex: 1; min-width: 220px;" ${approved.length ? '' : 'disabled'}>${options}</select>
            <button type="button" class="btn-primary" id="rel-bulk-send-${tipo}" onclick="startRelacionamentoCampaign('${tipo}')" ${approved.length ? '' : 'disabled'} style="white-space: nowrap;">
                <i class="fa-brands fa-whatsapp"></i> Disparar Campanha
            </button>
            <button type="button" class="btn-secondary" onclick="markRelSelectedAsContacted('${tipo}')" style="white-space: nowrap;">
                <i class="fa-solid fa-check"></i> Marcar como Contactado
            </button>
        `;
        bar.dataset.built = '1';
    }
    const countEl = bar.querySelector('.rel-bulk-count');
    if (countEl) countEl.innerText = `${count} selecionado(s)`;
}

function reloadRelSource(tipo) {
    if (tipo === 'posvenda' || tipo === 'faltantes' || tipo === 'sumidos') {
        relacionamentoFetched = false;
        fetchRelacionamento();
    } else if (tipo === 'aniversariantes-hoje') {
        aniversariantesHojeFetched = false;
        fetchAniversariantesHoje();
    } else if (tipo === 'aniversariantes-mes') {
        aniversariantesMesFetched = false;
        fetchAniversariantesMes();
    }
}

// Limite de conversas iniciadas por dia da Meta pra contas Tier 1 (novas/não
// verificadas) — ultrapassar arrisca mensagens rejeitadas ou queda na nota de
// qualidade do número. Mesmo valor usado no disparo em massa da aba de campanhas.
const RELACIONAMENTO_DISPATCH_LIMIT = 250;

async function startRelacionamentoCampaign(tipo) {
    const recipients = getRelSelectedRecipients(tipo);
    if (recipients.length === 0) return;

    if (recipients.length > RELACIONAMENTO_DISPATCH_LIMIT) {
        await customAlert(
            `Você selecionou ${recipients.length} pacientes, mas o limite por disparo é ${RELACIONAMENTO_DISPATCH_LIMIT} (limite diário da Meta pra contas Tier 1). Desmarque alguns e repita o disparo depois pro restante.`,
            'Limite de Disparo'
        );
        return;
    }

    const selectEl = document.getElementById(`rel-bulk-template-${tipo}`);
    const selectedValue = selectEl ? selectEl.value : '';
    if (!selectedValue) {
        alert('Selecione um template aprovado!');
        return;
    }
    const [templateName, languageCode] = selectedValue.split('|');

    const selectedTemplate = cachedWhatsappTemplates.find(t => t.name === templateName && t.language === languageCode);
    const templateCategory = (selectedTemplate && selectedTemplate.category) || 'UTILITY';
    const bodyComponent = selectedTemplate ? (selectedTemplate.components || []).find(c => c.type === 'BODY') : null;
    const bodyVarMatches = bodyComponent && bodyComponent.text ? (bodyComponent.text.match(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g) || []) : [];
    const bodyVarCount = bodyVarMatches.length;
    const bodyVarName = bodyVarMatches[0] ? bodyVarMatches[0].replace(/[{}\s]/g, '') : null;
    const isNamedParam = bodyVarName && !/^\d+$/.test(bodyVarName);
    if (bodyVarCount > 1) {
        alert(`O template "${templateName}" tem ${bodyVarCount} variáveis no corpo. Disparo em massa hoje só suporta templates sem variável ou com uma única variável (preenchida com o nome do paciente).`);
        return;
    }

    const pricingRates = await getWhatsappPricingRates();
    const costPerMessage = pricingRates[templateCategory] ?? pricingRates.UTILITY;

    const confirmed = await showDispatchConfirmModal({
        templateName,
        category: templateCategory,
        recipientCount: recipients.length,
        costPerMessage
    });
    if (!confirmed) return;

    const backendTipo = REL_TIPO_TO_BACKEND[tipo];

    // Troca a barra de seleção por uma mini área de progresso — o motor de disparo
    // (dispatchTemplateCampaign) espera esses elementos pra atualizar status/log/barra.
    const bar = document.getElementById(`rel-bulk-bar-${tipo}`);
    bar.style.display = 'block';
    bar.innerHTML = `
        <div style="width: 100%;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem; gap: 0.5rem;">
                <strong id="rel-bulk-status-${tipo}">Em progresso...</strong>
                <span id="rel-bulk-progress-text-${tipo}" style="font-size: 0.8rem; color: var(--text-muted);">0 / ${recipients.length} processados</span>
            </div>
            <div style="height: 6px; background: rgba(255,255,255,0.08); border-radius: 99px; overflow: hidden; margin-bottom: 0.5rem;">
                <div id="rel-bulk-progress-bar-${tipo}" style="height: 100%; width: 100%; transform: scaleX(0); transform-origin: left center; background: var(--accent-primary); transition: transform .2s;"></div>
            </div>
            <div id="rel-bulk-log-${tipo}" style="max-height: 140px; overflow-y: auto; font-size: 0.78rem; font-family: monospace; background: rgba(0,0,0,0.2); border-radius: 6px; padding: 0.5rem;"></div>
        </div>
    `;

    // dispatchTemplateCampaign mexe em btn.disabled/innerHTML — aqui não tem um botão
    // "oficial" pra desabilitar durante o envio, então passamos um <button> descartável.
    const dummyBtn = document.createElement('button');

    await dispatchTemplateCampaign(recipients, {
        templateName, languageCode, templateCategory, costPerMessage,
        bodyVarCount, isNamedParam, bodyVarName,
        targetLabel: `relacionamento:${tipo}`,
        els: {
            btn: dummyBtn,
            logBox: document.getElementById(`rel-bulk-log-${tipo}`),
            statusText: document.getElementById(`rel-bulk-status-${tipo}`),
            progressText: document.getElementById(`rel-bulk-progress-text-${tipo}`),
            progressBar: document.getElementById(`rel-bulk-progress-bar-${tipo}`)
        },
        onResult: (lead, success) => {
            // Só marca como contactado em sucesso real confirmado pela Meta — diferente
            // do botão manual antigo, que marcava só no clique, antes até de enviar.
            if (success) registerMessageSent(lead.id, backendTipo, null);
        }
    });

    setTimeout(() => reloadRelSource(tipo), 1500);
}

async function markRelSelectedAsContacted(tipo) {
    const recipients = getRelSelectedRecipients(tipo);
    if (recipients.length === 0) return;
    if (!(await customConfirm(`Marcar ${recipients.length} paciente(s) como já contactado(s), sem enviar mensagem? Use isso pra quem você já abordou por outro canal (ligação, presencial, etc).`, 'Marcar como Contactado'))) return;

    const backendTipo = REL_TIPO_TO_BACKEND[tipo];
    await Promise.all(recipients.map(r =>
        fetch('/api/mensagens', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paciente_id: r.id, tipo: backendTipo })
        }).catch(e => console.error('Erro ao marcar como contactado:', e))
    ));

    reloadRelSource(tipo);
}

function getWhatsAppLink(phone, name, type) {
    if (!phone) return '#';
    const raw = phone.replace(/\D/g, '');
    
    let text = "";
    if (name && type) {
        const firstName = name.split(" ")[0];
        if (type === 'pos_venda') {
            text = `Olá ${firstName}, tudo bem? Aqui é da Natuclinic! Vimos que você esteve conosco recentemente...`;
        } else if (type === 'faltantes') {
            text = `Olá ${firstName}! Sentimos sua falta na sua última consulta agendada na Natuclinic...`;
        } else if (type === 'sumidos') {
            text = `Olá ${firstName}, tudo bem? Faz um tempinho que não te vemos aqui na Natuclinic...`;
        } else if (type === 'aniversariante') {
            text = `Parabéns ${firstName}! 🎉 Que seu dia seja cheio de alegrias e muita saúde! Um grande abraço de toda a equipe Natuclinic!`;
        }
    }
    
    const url = `https://wa.me/55${raw}`;
    return text ? `${url}?text=${encodeURIComponent(text)}` : url;
}

function formatPhone(phone) {
    if (!phone) return '-';
    if (phone.length === 11) {
        return `(${phone.substring(0,2)}) ${phone.substring(2,7)}-${phone.substring(7,11)}`;
    }
    return phone;
}

function renderPosVendaCard(item) {
    const p = item.patient;
    const dateStr = item.last_attendance ? new Date(item.last_attendance.start_date).toLocaleDateString('pt-BR') : '-';
    const service = escapeHtml(item.last_attendance?.agenda_event?.name || '-');

    return `
        <tr>
            <td style="text-align: center;" class="rel-select-col"><input type="checkbox" class="rel-select" data-tipo="posvenda" data-id="${escapeHtml(String(p.id))}" data-nome="${escapeHtml(p.name)}" data-telefone="${escapeHtml(p.phone || '')}" onchange="updateRelBulkBar('posvenda')"></td>
            <td style="font-weight: 500;">
                <div style="display: flex; align-items: center; gap: 0.75rem;">
                    <div style="width: 32px; height: 32px; border-radius: 50%; background: rgba(59, 130, 246, 0.1); display: flex; align-items: center; justify-content: center; color: var(--accent-primary);">
                        <i class="fa-solid fa-user"></i>
                    </div>
                    ${escapeHtml(p.name)}
                </div>
            </td>
            <td>${formatPhone(p.phone)}</td>
            <td>${dateStr} <br><small style="color: var(--text-muted);">${service}</small></td>
            <td style="text-align: center;">
                ${item.contacted ? 
                    `<button disabled class="btn-secondary" style="width: 100%; justify-content: center; background: rgba(255, 255, 255, 0.05); color: var(--text-muted); cursor: not-allowed; border: none; padding: 0.5rem;">
                        <i class="fa-solid fa-check"></i> Já Contactado
                    </button>` : 
                    `<a href="${getWhatsAppLink(p.phone, p.name, 'pos_venda')}" onclick="registerMessageSent('${p.id}', 'pos_venda', this)" target="_blank" class="btn-secondary" style="width: 100%; justify-content: center; background: rgba(16, 185, 129, 0.15); color: var(--accent-success); border-color: rgba(16, 185, 129, 0.3); text-decoration: none; padding: 0.5rem;">
                        <i class="fa-brands fa-whatsapp"></i> Fazer Pós Venda
                    </a>`
                }
            </td>
        </tr>
    `;
}

function renderFaltantesCard(item) {
    const p = item.patient;
    const dateStr = item.last_attendance ? new Date(item.last_attendance.start_date).toLocaleDateString('pt-BR') : '-';
    const service = escapeHtml(item.last_attendance?.agenda_event?.name || '-');

    return `
        <tr>
            <td style="text-align: center;" class="rel-select-col"><input type="checkbox" class="rel-select" data-tipo="faltantes" data-id="${escapeHtml(String(p.id))}" data-nome="${escapeHtml(p.name)}" data-telefone="${escapeHtml(p.phone || '')}" onchange="updateRelBulkBar('faltantes')"></td>
            <td style="font-weight: 500;">
                <div style="display: flex; align-items: center; gap: 0.75rem;">
                    <div style="width: 32px; height: 32px; border-radius: 50%; background: rgba(59, 130, 246, 0.1); display: flex; align-items: center; justify-content: center; color: var(--accent-primary);">
                        <i class="fa-solid fa-user"></i>
                    </div>
                    ${escapeHtml(p.name)}
                </div>
            </td>
            <td>${formatPhone(p.phone)}</td>
            <td><span style="color: var(--accent-danger);"><i class="fa-solid fa-user-xmark"></i> Faltou: ${dateStr}</span> <br><small style="color: var(--text-muted);">${service}</small></td>
            <td style="text-align: center;">
                ${item.contacted ? 
                    `<button disabled class="btn-secondary" style="width: 100%; justify-content: center; background: rgba(255, 255, 255, 0.05); color: var(--text-muted); cursor: not-allowed; border: none; padding: 0.5rem;">
                        <i class="fa-solid fa-check"></i> Já Contactado
                    </button>` : 
                    `<a href="${getWhatsAppLink(p.phone, p.name, 'faltantes')}" onclick="registerMessageSent('${p.id}', 'faltantes', this)" target="_blank" class="btn-secondary" style="width: 100%; justify-content: center; background: rgba(16, 185, 129, 0.15); color: var(--accent-success); border-color: rgba(16, 185, 129, 0.3); text-decoration: none; padding: 0.5rem;">
                        <i class="fa-brands fa-whatsapp"></i> Reagendar Consulta
                    </a>`
                }
            </td>
        </tr>
    `;
}

function renderSumidosCard(item) {
    const p = item.patient;
    const dateStr = item.last_attendance ? new Date(item.last_attendance.start_date).toLocaleDateString('pt-BR') : '-';

    return `
        <tr>
            <td style="text-align: center;" class="rel-select-col"><input type="checkbox" class="rel-select" data-tipo="sumidos" data-id="${escapeHtml(String(p.id))}" data-nome="${escapeHtml(p.name)}" data-telefone="${escapeHtml(p.phone || '')}" onchange="updateRelBulkBar('sumidos')"></td>
            <td style="font-weight: 500;">
                <div style="display: flex; align-items: center; gap: 0.75rem;">
                    <div style="width: 32px; height: 32px; border-radius: 50%; background: rgba(59, 130, 246, 0.1); display: flex; align-items: center; justify-content: center; color: var(--accent-primary);">
                        <i class="fa-solid fa-user"></i>
                    </div>
                    ${escapeHtml(p.name)}
                </div>
            </td>
            <td>${formatPhone(p.phone)}</td>
            <td><span style="color: var(--accent-warning);"><i class="fa-solid fa-clock-rotate-left"></i> Sumido há ${item.days_absent || '-'} dias</span> <br><small style="color: var(--text-muted);">Último: ${dateStr}</small></td>
            <td style="text-align: center;">
                ${item.contacted ? 
                    `<button disabled class="btn-secondary" style="width: 100%; justify-content: center; background: rgba(255, 255, 255, 0.05); color: var(--text-muted); cursor: not-allowed; border: none; padding: 0.5rem;">
                        <i class="fa-solid fa-check"></i> Já Contactado
                    </button>` : 
                    `<a href="${getWhatsAppLink(p.phone, p.name, 'sumidos')}" onclick="registerMessageSent('${p.id}', 'sumidos', this)" target="_blank" class="btn-secondary" style="width: 100%; justify-content: center; background: rgba(16, 185, 129, 0.15); color: var(--accent-success); border-color: rgba(16, 185, 129, 0.3); text-decoration: none; padding: 0.5rem;">
                        <i class="fa-brands fa-whatsapp"></i> Tentar Resgate
                    </a>`
                }
            </td>
        </tr>
    `;
}

// === ENVIO DE MENSAGENS (CLOUDFLARE D1) ===
function registerMessageSent(pacienteId, tipo, el) {
    // Muda a UI imediatamente para não enviar duas vezes enquanto a api pensa
    if(el) {
        el.outerHTML = `<button disabled class="btn-secondary" style="width: 100%; justify-content: center; background: rgba(16, 185, 129, 0.15); color: var(--accent-success); border: 1px solid rgba(16, 185, 129, 0.3); opacity: 0.6; cursor: not-allowed; padding: 0.5rem; text-decoration: none;">
                    <i class="fa-solid fa-check"></i> Enviado
                </button>`;
    }
    
    fetch('/api/mensagens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paciente_id: pacienteId, tipo: tipo })
    }).catch(e => console.error("Erro ao registrar envio:", e));
}

// === AGENDA (GRID VIEW) ===
let currentAgendaDateObj = new Date();
let currentAgendaDate = currentAgendaDateObj.toISOString().split('T')[0]; // Hoje

function formatTime(dateObj) {
    const hh = String(dateObj.getHours()).padStart(2, '0');
    const mm = String(dateObj.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

// === GESTÃO DE ACESSOS (ADMIN) ===
async function openUsuariosModal() {
    if (loggedUser.role !== 'admin') return;
    document.getElementById('modalUsuarios').classList.add('active');
    await loadUsers();
}

// Guarda o último resultado de /api/users pra preencher o modal de edição sem novo request.
let _accessUsersCache = [];

async function loadUsers() {
    const tbody = document.getElementById('usuarios-tbody');
    tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 1rem;"><span class="amicro-loader"><span></span><span></span><span></span></span> Carregando...</td></tr>';

    try {
        const res = await fetch('/api/users');
        const users = await res.json();
        if (!res.ok) throw new Error(users.error || 'Erro ao carregar usuários');
        _accessUsersCache = Array.isArray(users) ? users : [];

        tbody.innerHTML = '';
        _accessUsersCache.forEach(u => {
            const isAdmin = u.role === 'admin';
            const isRoot = u.username === 'admin';
            const displayName = (u.display_name && u.display_name.trim()) ? u.display_name : '';
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="font-weight: 600;">${escapeHtml(u.username)}</td>
                <td>${displayName ? escapeHtml(displayName) : '<span class="access-muted">—</span>'}</td>
                <td><span class="access-role-badge ${isAdmin ? 'is-admin' : 'is-user'}">${isAdmin ? 'admin' : 'user'}</span></td>
                <td>
                    <div class="access-row-actions">
                        <button class="access-icon-btn" title="Editar acesso" onclick="openEditUser('${encodeURIComponent(u.username)}')">
                            <i class="fa-solid fa-pen"></i>
                        </button>
                        ${isRoot ? '' : `<button class="access-icon-btn is-danger" title="Excluir acesso" onclick="deleteUser('${encodeURIComponent(u.username)}')">
                            <i class="fa-solid fa-trash"></i>
                        </button>`}
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--accent-danger, #ef4444); padding: 1rem;">${escapeHtml(e.message)}</td></tr>`;
    }
}

async function createUser() {
    const username = document.getElementById('nu-user').value.trim();
    const password = document.getElementById('nu-pass').value.trim();
    const role = document.getElementById('nu-role').value;

    if (!username || !password) return await customAlert('Preencha usuário e senha!');
    if (password.length < 6) return await customAlert('A senha precisa ter pelo menos 6 caracteres.');

    try {
        const res = await fetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, role })
        });

        const data = await res.json();
        if (data.error) throw new Error(data.error);

        document.getElementById('nu-user').value = '';
        document.getElementById('nu-pass').value = '';
        document.getElementById('nu-role').value = 'user';
        if (typeof showToast === 'function') showToast(`Acesso "${username}" criado.`);
        loadUsers();
    } catch (e) {
        await customAlert(e.message);
    }
}

function openEditUser(usernameEnc) {
    const username = decodeURIComponent(usernameEnc);
    const u = _accessUsersCache.find(x => x.username === username);
    if (!u) return;

    document.getElementById('eu-username').value = username;
    document.getElementById('eu-username-view').value = username;
    document.getElementById('eu-title-name').textContent = (u.display_name && u.display_name.trim()) ? u.display_name : username;
    document.getElementById('eu-display-name').value = (u.display_name && u.display_name.trim()) ? u.display_name : '';
    document.getElementById('eu-password').value = '';
    document.getElementById('eu-role').value = u.role === 'admin' ? 'admin' : 'user';

    // O admin principal não pode perder o cargo de administrador.
    document.getElementById('eu-role').disabled = (username === 'admin');

    document.getElementById('modalEditUser').classList.add('active');
}

async function saveEditUser() {
    const username = document.getElementById('eu-username').value;
    const display_name = document.getElementById('eu-display-name').value.trim();
    const password = document.getElementById('eu-password').value.trim();
    const role = document.getElementById('eu-role').value;

    if (password && password.length < 6) {
        return await customAlert('A nova senha precisa ter pelo menos 6 caracteres.');
    }

    const payload = { display_name, role };
    if (password) payload.password = password;

    try {
        const res = await fetch(`/api/users/${encodeURIComponent(username)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        document.getElementById('modalEditUser').classList.remove('active');
        if (typeof showToast === 'function') {
            showToast(password ? `Acesso "${username}" atualizado — nova senha definida.` : `Acesso "${username}" atualizado.`);
        }
        loadUsers();
        if (typeof loadDisplayNamesMap === 'function') loadDisplayNamesMap();
    } catch (e) {
        await customAlert(e.message);
    }
}

async function deleteUser(usernameEnc) {
    const username = decodeURIComponent(usernameEnc);
    if (!await customConfirm(`Tem certeza que deseja excluir o acesso de ${username}?`)) return;
    try {
        const res = await fetch(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        if (typeof showToast === 'function') showToast(`Acesso "${username}" removido.`);
        loadUsers();
    } catch (e) {
        await customAlert(e.message);
    }
}

function updateAgendaDateDisplay() {
    const weekdays = ['Domingo', 'Segunda-Feira', 'Terça-Feira', 'Quarta-Feira', 'Quinta-Feira', 'Sexta-Feira', 'Sábado'];
    const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    
    const w = weekdays[currentAgendaDateObj.getDay()];
    const d = currentAgendaDateObj.getDate().toString().padStart(2, '0');
    const m = months[currentAgendaDateObj.getMonth()];
    const y = currentAgendaDateObj.getFullYear();
    
    const text = `${w}, ${d} ${m} ${y}`;
    const displayEl = document.getElementById('agenda-date-display');
    if(displayEl) displayEl.innerText = text;
}

function pesquisarPacienteDropdown(term) {
    const dropdown = document.getElementById('agenda-search-dropdown');
    const termLower = term.toLowerCase().trim();
    
    // Limpa destaque antigo
    document.querySelectorAll('.agenda-block').forEach(block => {
        block.style.opacity = '1';
        block.style.boxShadow = '';
        block.style.zIndex = '1';
    });

    if (termLower === "") {
        dropdown.style.display = 'none';
        return;
    }
    
    if (!window.currentAgendaAttendances || window.currentAgendaAttendances.length === 0) {
        dropdown.innerHTML = `<div style="padding: 0.8rem; color: var(--text-muted); font-size: 0.9rem; text-align: center;">Nenhum agendamento carregado.</div>`;
        dropdown.style.display = 'block';
        return;
    }

    // 1. Filtra agendamentos atuais pelo nome do paciente
    let resultados = (window.currentAgendaAttendances || []).filter(att => {
        if (!att.patient || !att.patient.name) return false;
        return att.patient.name.toLowerCase().includes(termLower);
    });

    // 2. Filtra também nos pacientes do Kanban (Leads)
    const leadsFiltrados = (leads || []).filter(lead => {
        if (!lead.nome) return false;
        return lead.nome.toLowerCase().includes(termLower);
    });

    // Remove duplicatas usando o nome como chave para unificar agenda e leads
    const unicos = [];
    const mapNomes = new Set();
    
    // Processa Agenda
    for (const res of resultados) {
        const nome = res.patient.name.trim().toLowerCase();
        if (!mapNomes.has(nome)) {
            mapNomes.add(nome);
            unicos.push({
                id: res.id,
                name: res.patient.name,
                phone: res.patient.phone || res.patient.cellphone || '',
                source: 'agenda'
            });
        }
    }
    
    // Processa Leads (Kanban)
    for (const lead of leadsFiltrados) {
        const nome = lead.nome.trim().toLowerCase();
        if (!mapNomes.has(nome)) {
            mapNomes.add(nome);
            unicos.push({
                id: lead.id,
                name: lead.nome,
                phone: lead.telefone || '',
                source: 'kanban'
            });
        }
    }

    if (unicos.length === 0) {
        dropdown.innerHTML = `<div style="padding: 0.8rem; color: var(--text-muted); font-size: 0.9rem; text-align: center;">Nenhum paciente encontrado.</div>`;
    } else {
        dropdown.innerHTML = unicos.map(item => {
            const badge = item.source === 'kanban' 
                ? '<span style="font-size: 0.7rem; background: var(--accent-warning); color: #000; padding: 0.1rem 0.3rem; border-radius: 4px; margin-left: 5px;">CRM</span>'
                : '<span style="font-size: 0.7rem; background: var(--accent-success); color: #fff; padding: 0.1rem 0.3rem; border-radius: 4px; margin-left: 5px;">Agenda</span>';
                
            return `
            <div class="ag-dropdown-item" style="display: flex; align-items: center; justify-content: space-between; padding: 0.8rem 1rem;" onclick="selecionarPacienteBusca('${item.id}', '${item.name}', '${item.source}')">
                <div>
                    <span style="font-weight: 500; color: var(--text-main);">${item.name}</span>
                    ${badge}
                </div>
                <span style="font-size: 0.75rem; background: rgba(255,255,255,0.1); padding: 0.2rem 0.4rem; border-radius: 4px; color: var(--text-muted);">${item.phone || '-'}</span>
            </div>
            `;
        }).join('');
    }
    dropdown.style.display = 'block';
}

function selecionarPacienteBusca(attId, patientName) {
    const input = document.getElementById('agenda-search-input');
    const dropdown = document.getElementById('agenda-search-dropdown');
    input.value = patientName;
    dropdown.style.display = 'none';
    
    // Agora destaca no calendário todos os agendamentos desse paciente
    const termLower = patientName.toLowerCase().trim();
    document.querySelectorAll('.agenda-block').forEach(block => {
        const text = block.innerText.toLowerCase();
        if (text.includes(termLower)) {
            block.style.boxShadow = '0 0 0 3px rgba(16, 185, 129, 0.8)'; // verde destaque
            block.style.zIndex = '10';
            block.style.opacity = '1';
        } else {
            block.style.opacity = '0.2';
            block.style.boxShadow = '';
            block.style.zIndex = '1';
        }
    });
}

// Fechar dropdown da agenda ao clicar fora
document.addEventListener('click', (e) => {
    const drop = document.getElementById('agenda-search-dropdown');
    const input = document.getElementById('agenda-search-input');
    if (drop && input && !input.contains(e.target) && !drop.contains(e.target)) {
        drop.style.display = 'none';
    }
});

function resetAgendaDate() {
    currentAgendaDateObj = new Date();
    // Ajuste fuso horário
    const offset = currentAgendaDateObj.getTimezoneOffset() * 60000;
    const localISOTime = (new Date(currentAgendaDateObj - offset)).toISOString().slice(0, -1);
    currentAgendaDate = localISOTime.split('T')[0];
    
    updateAgendaDateDisplay();
    renderAgendaGrid();
}

function changeAgendaDate(days) {
    currentAgendaDateObj.setDate(currentAgendaDateObj.getDate() + days);
    // Para evitar problemas de fuso, criamos a string YYYY-MM-DD ajustada pelo fuso local
    const offset = currentAgendaDateObj.getTimezoneOffset() * 60000;
    const localISOTime = (new Date(currentAgendaDateObj - offset)).toISOString().slice(0, -1);
    currentAgendaDate = localISOTime.split('T')[0];
    
    updateAgendaDateDisplay();
    renderAgendaGrid();
}

function jumpToDate(dateString) {
    if (!dateString) return;
    const [year, month, day] = dateString.split('-');
    // Month in Date is 0-indexed
    currentAgendaDateObj = new Date(year, month - 1, day);
    
    const offset = currentAgendaDateObj.getTimezoneOffset() * 60000;
    const localISOTime = (new Date(currentAgendaDateObj - offset)).toISOString().slice(0, -1);
    currentAgendaDate = localISOTime.split('T')[0];
    
    updateAgendaDateDisplay();
    renderAgendaGrid();
}

async function renderAgendaGrid() {
    const gridLayout = document.getElementById('agenda-grid-layout');
    const gridBody = document.getElementById('agenda-grid-body');
    const loader = document.querySelector('.agenda-loader');
    
    if (loader) loader.style.display = 'flex';
    gridBody.innerHTML = '';
    
    // Remover cabeçalhos antigos (se houver), mantendo apenas o grid-body
    Array.from(gridLayout.children).forEach(child => {
        if (child.id !== 'agenda-grid-body') child.remove();
    });
    
    try {
        const unidadeId = typeof getSelectedUnidadeId === 'function' ? getSelectedUnidadeId() : '';
        const response = await fetch(`/api/agenda?start_date=${currentAgendaDate}${unidadeId ? `&unidade_id=${encodeURIComponent(unidadeId)}` : ''}`);
        const result = await response.json();

        if (!response.ok) throw new Error(result.error || "Erro ao buscar API");
        
        const attendances = result.data || [];
        window.currentAgendaAttendances = attendances; // Store globally for the modal
        
        // 1. Processar Profissionais (Colunas)
        let doctorsMap = new Map();
        if (apiOptions.doctors && apiOptions.doctors.length > 0) {
            apiOptions.doctors.forEach(doc => doctorsMap.set(doc.id, { id: doc.id, name: doc.name }));
        }
        // A rota /api/agenda agora devolve a lista de profissionais junto — garante
        // todas as colunas já na 1ª renderização, sem depender do /api/options.
        (result.doctors || []).forEach(doc => {
            if (doc && doc.id != null) doctorsMap.set(doc.id, { id: doc.id, name: doc.name || 'Sem nome' });
        });

        // Adicionar qualquer profissional que esteja nos agendamentos mas não veio na lista de doctors
        attendances.forEach(att => {
            if (att.user && att.user.id && !doctorsMap.has(att.user.id)) {
                doctorsMap.set(att.user.id, { id: att.user.id, name: att.user.name });
            }
        });

        // Acumula todo profissional visto (neste dia + opções) na união persistente,
        // pra que as colunas não sumam nos dias em que a pessoa não tem agendamento.
        agendaRememberDoctors(Array.from(doctorsMap.values()));

        // Se as opções ainda não trouxeram a lista de profissionais, dispara a busca
        // uma vez — ela re-renderiza a grade quando terminar.
        if ((!apiOptions.doctors || apiOptions.doctors.length === 0) && !_agendaOptionsKicked && typeof fetchApiOptions === 'function') {
            _agendaOptionsKicked = true;
            fetchApiOptions();
        }

        const allDoctors = Array.from(agendaKnownDoctors.values())
            .filter(d => !isAgendaPhantomDoctor(d.name))
            .sort((a, b) => a.name.localeCompare(b.name));

        // Colunas = união conhecida menos quem está oculto no filtro.
        let doctors = allDoctors.filter(d => !agendaHiddenProfs.has(String(d.id)));

        let agendaEmptyMsg = '';
        if (allDoctors.length === 0) {
            doctors = [{ id: 0, name: 'Carregando profissionais…' }];
        } else if (doctors.length === 0) {
            doctors = [{ id: 0, name: 'Nenhum profissional selecionado' }];
            agendaEmptyMsg = 'Todos os profissionais estão ocultos. Use o filtro "Profissionais" para exibir.';
        }

        // Atualiza o filtro (checkboxes) com a lista completa conhecida.
        renderAgendaProfFilter(allDoctors);

        // 2. Ajustar CSS Grid Dinâmico
        gridLayout.style.setProperty('--col-count', doctors.length);
        
        // 3. Renderizar Cabeçalhos das Colunas — limpa qualquer header que tenha
        //    sobrado (inclusive de uma renderização concorrente) e insere tudo de
        //    uma vez, logo antes do grid-body. Sem isso, duas chamadas simultâneas
        //    de renderAgendaGrid() empilhavam um "Horário" a mais.
        gridLayout.querySelectorAll('.grid-col-header').forEach(h => h.remove());
        const headersHtml = `<div class="grid-col-header time-col-header">Horário</div>` +
            doctors.map(doc => `<div class="grid-col-header">${escapeHtml(doc.name)}</div>`).join('');
        gridBody.insertAdjacentHTML('beforebegin', headersHtml);
        
        // 4. Gerar Grade Base (08:00 até 18:00, a cada 20 min)
        const times = [];
        for(let h=8; h<=18; h++) {
            for(let m=0; m<60; m+=20) {
                if (h === 18 && m > 0) continue;
                times.push(`${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}`);
            }
        }
        
        times.forEach((time, index) => {
            const row = index + 2;
            gridBody.insertAdjacentHTML('beforeend', `<div class="time-slot" style="grid-column: 1; grid-row: ${row};">${time}</div>`);

            for(let c=2; c<=doctors.length+1; c++) {
                const docId = doctors[c-2].id;
                gridBody.insertAdjacentHTML('beforeend', `<div class="grid-cell clickable-cell" onclick="openGridScheduleModal('${docId}', '${time}')" style="grid-column: ${c}; grid-row: ${row};"></div>`);
            }
        });

        if (agendaEmptyMsg) {
            gridBody.insertAdjacentHTML('beforeend',
                `<div class="agenda-empty-overlay" style="grid-column: 2 / -1; grid-row: 2 / 12;">${escapeHtml(agendaEmptyMsg)}</div>`);
        }
        
        // 5. Agrupar Agendamentos por Doutor para tratar colisões (overlap)
        const attendancesByDoc = {};
        doctors.forEach(d => attendancesByDoc[d.id] = []);
        
        attendances.forEach(att => {
            if (!att.start_date) return;
            if (att.user && att.user.id && attendancesByDoc[att.user.id] !== undefined) {
                attendancesByDoc[att.user.id].push(att);
            }
        });
        
        // Processar os blocos de cada doutor
        for (const docId of Object.keys(attendancesByDoc)) {
            const docAtts = attendancesByDoc[docId];
            
            // Ordenar por hora de início. Se houver empate, o de MAIOR duração vem primeiro.
            docAtts.sort((a, b) => {
                const startDiff = new Date(a.start_date) - new Date(b.start_date);
                if (startDiff !== 0) return startDiff;
                
                const endA = a.end_date ? new Date(a.end_date).getTime() : new Date(a.start_date).getTime() + 60*60*1000;
                const endB = b.end_date ? new Date(b.end_date).getTime() : new Date(b.start_date).getTime() + 60*60*1000;
                const durA = endA - new Date(a.start_date).getTime();
                const durB = endB - new Date(b.start_date).getTime();
                
                return durB - durA; // Duração decrescente
            });
            
            // Identificar grupos de colisões
            let currentGroup = [];
            let maxEndInGroup = 0;
            const groups = [];
            
            docAtts.forEach(att => {
                const start = new Date(att.start_date).getTime();
                const end = att.end_date ? new Date(att.end_date).getTime() : start + 60*60*1000;
                
                if (currentGroup.length === 0) {
                    currentGroup.push(att);
                    maxEndInGroup = end;
                } else {
                    // Se o inicio deste evento for menor que o maior fim do grupo, colide!
                    if (start < maxEndInGroup) {
                        currentGroup.push(att);
                        if (end > maxEndInGroup) maxEndInGroup = end;
                    } else {
                        groups.push(currentGroup);
                        currentGroup = [att];
                        maxEndInGroup = end;
                    }
                }
            });
            if (currentGroup.length > 0) groups.push(currentGroup);
            
            // Renderizar cada grupo calculando o width e margin-left
            groups.forEach(group => {
                const totalSimultaneous = group.length;
                
                group.forEach((att, index) => {
                    const startDate = new Date(att.start_date);
                    const endDate = att.end_date ? new Date(att.end_date) : new Date(startDate.getTime() + 60*60*1000);
                    
                    const startHour = startDate.getUTCHours();
                    const startMin = startDate.getUTCMinutes();
                    const endHour = endDate.getUTCHours();
                    const endMin = endDate.getUTCMinutes();
                    
                    let rowStart = Math.floor((startHour - 8) * 3 + (startMin / 20) + 2);
                    let rowEnd = Math.floor((endHour - 8) * 3 + (endMin / 20) + 2);
                    
                    if (rowStart < 2) rowStart = 2;
                    if (rowEnd <= rowStart) rowEnd = rowStart + 1;
                    
                    const col = doctors.findIndex(d => String(d.id) === String(docId)) + 2;
                    
                    const title = att.agenda_event ? att.agenda_event.name : 'Procedimento';
                    const subtitle = att.patient ? att.patient.name : 'Sem nome';
                    const startTimeStr = `${startHour.toString().padStart(2,'0')}:${startMin.toString().padStart(2,'0')}`;
                    const endTimeStr = `${endHour.toString().padStart(2,'0')}:${endMin.toString().padStart(2,'0')}`;
                    const timeText = `${startTimeStr} - ${endTimeStr}`;
                    
                    // Gerar cor dinâmica baseada no nome do procedimento via Variáveis CSS (Suporta Tema Claro e Escuro)
                    const paletteVars = [
                        { var: 'c1' }, // Rosa Claro
                        { var: 'c2' }, // Rosa Pastel
                        { var: 'c3' }, // Rose Salmão
                        { var: 'c4' }, // Pêssego
                        { var: 'c5' }, // Dourado Pastel
                        { var: 'c6' }, // Bege
                        { var: 'c7' }  // Cinza Neutro
                    ];
                    
                    let colorVar = paletteVars[0].var;
                    if (title.toLowerCase().includes('bloqueio')) {
                        colorVar = 'block'; // Usar variáveis de bloqueio
                    } else {
                        let hash = 0;
                        for (let i = 0; i < title.length; i++) {
                            hash = title.charCodeAt(i) + ((hash << 5) - hash);
                        }
                        hash = Math.abs(hash);
                        colorVar = paletteVars[hash % paletteVars.length].var;
                    }
                    
                    let statusIcon = '<i class="fa-regular fa-clock" title="Agendado"></i>';
                    let extraStyles = `background: var(--agenda-${colorVar}-bg); border: 1px solid var(--agenda-${colorVar}-border-strong); border-left: 4px solid var(--agenda-${colorVar}-border-strong); color: var(--agenda-${colorVar}-text);`;
                    
                    if (att.canceled || att.status === 'canceled') {
                        statusIcon = '<i class="fa-solid fa-ban" style="color: #ef4444;" title="Cancelado"></i>';
                        extraStyles += ' opacity: 0.5; text-decoration: line-through; border: 1px solid #ef4444;';
                    } else if (att.missed) {
                        statusIcon = '<i class="fa-solid fa-user-xmark" style="color: #f97316;" title="Faltou"></i>';
                        extraStyles += ' opacity: 0.6;';
                    } else if (att.done || att.status === 'done') {
                        statusIcon = '<i class="fa-solid fa-check-double" style="color: #10b981;" title="Finalizado"></i>';
                    } else if (att.arrived || att.in_attendance || att.status === 'arrived' || att.status === 'in_attendance') {
                        statusIcon = '<i class="fa-solid fa-user-clock" style="color: #3b82f6;" title="Na Clínica"></i>';
                    } else if (att.confirmed_at || att.status === 'confirmed') {
                        statusIcon = '<i class="fa-solid fa-check" style="color: #10b981;" title="Confirmado"></i>';
                    }
                    
                    // Lógica de colisão estilo Amigo App (Zigue-Zague)
                    let leftPct = 2;
                    let widthPct = 96;
                    
                    if (totalSimultaneous > 1) {
                        const isEven = index % 2 === 0;
                        leftPct = isEven ? 2 : 20; // Alterna margem
                        widthPct = 78; // Reduz a largura para caber no zigue-zague
                    }
                    
                    const zIndex = 10 + index;
                    
                    const inlineStyle = `grid-column: ${col}; grid-row: ${rowStart} / ${rowEnd}; width: calc(${widthPct}% - 4px); margin-left: ${leftPct}%; z-index: ${zIndex}; box-shadow: none; ${extraStyles}`;
                    
                    const html = `
                        <div class="agenda-block" style="${inlineStyle}" data-tooltip="${title} - ${subtitle}" onclick="openPatientDetailsModal('${att.id}', event)">
                            <strong>${statusIcon} ${timeText} | ${title}</strong>
                            ${subtitle}
                        </div>
                    `;
                    gridBody.insertAdjacentHTML('beforeend', html);
                });
            });
        }
        
        // Reaplicar filtro caso haja texto na busca
        const searchInput = document.getElementById('agenda-search-input');
        if (searchInput && searchInput.value) {
            filterAgenda(searchInput.value);
        }

        // 6. Linha do Tempo Atual (se for o dia de hoje)
        const todayForLine = new Date();
        if (currentAgendaDateObj.toDateString() === todayForLine.toDateString()) {
            const h = todayForLine.getHours();
            const m = todayForLine.getMinutes();
            if (h >= 8 && h < 18) {
                const totalMinutes = (h - 8) * 60 + m;
                const rowStart = Math.floor((h - 8) * 3 + (m / 20) + 2);
                const remainderMin = totalMinutes % 20;
                const topPct = (remainderMin / 20) * 100;
                
                const lineHtml = `
                    <div id="timeline-indicator" style="grid-row: ${rowStart}; grid-column: 1 / -1; position: relative; pointer-events: none; z-index: 50;">
                        <div style="position: absolute; top: ${topPct}%; left: 0; right: 0; border-top: 1.5px solid #ef4444; box-shadow: none;"></div>
                        <div style="position: absolute; top: ${topPct}%; left: 0; transform: translateY(-50%); width: 0; height: 0; border-top: 5px solid transparent; border-bottom: 5px solid transparent; border-left: 6px solid #ef4444;"></div>
                    </div>
                `;
                gridBody.insertAdjacentHTML('beforeend', lineHtml);
            }
        }
        
    } catch (e) {
        console.error("Erro na Grade:", e);
        await customAlert("Erro ao buscar a agenda: " + e.message);
    } finally {
        if (loader) loader.style.display = 'none';
    }
}

// === AUTO REFRESH DA AGENDA ===
setInterval(() => {
    // Só atualiza se a aba da agenda estiver visível
    const agendaView = document.getElementById('view-agenda');
    if (agendaView && agendaView.style.display !== 'none') {
        renderAgendaGrid();
    }
}, 60000); // A cada 60 segundos

// Init
renderBoard();

// ============================================
// LÓGICA DE ANIVERSARIANTES (DUPLA: API + CSV)
// ============================================
let aniversariantesHojeData = [];
let aniversariantesMesData = [];
let aniversariantesHojeFetched = false;
let aniversariantesMesFetched = false;

async function fetchAniversariantesHoje() {
    if (aniversariantesHojeFetched) return;
    try {
        const res = await fetch('/api/aniversariantes');
        if (!res.ok) throw new Error("Erro API Oficial");
        const data = await res.json();
        
        aniversariantesHojeData = data.aniversariantes || [];
        renderAniversariantesHoje();
        aniversariantesHojeFetched = true;
    } catch (e) {
        console.error(e);
        document.getElementById('list-aniversariantes-hoje').innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 2rem; color: var(--accent-danger);">Não foi possível carregar os dados da API oficial.</td></tr>`;
    }
}

async function fetchAniversariantesMes() {
    if (aniversariantesMesFetched) return;
    try {
        const res = await fetch('/api/aniversariantes/month');
        if (!res.ok) throw new Error("Erro CSV Local");
        const data = await res.json();
        
        aniversariantesMesData = data.aniversariantes || [];
        renderAniversariantesMes();
        aniversariantesMesFetched = true;
    } catch (e) {
        console.error(e);
        document.getElementById('list-aniversariantes-mes').innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 2rem; color: var(--accent-danger);">Não foi possível carregar a planilha local.</td></tr>`;
    }
}

function renderAniversariantesHoje() {
    const list = document.getElementById('list-aniversariantes-hoje');
    if (!list) return;
    resetRelBulkBar('aniversariantes-hoje');

    if (aniversariantesHojeData.length === 0) {
        list.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 2rem; color: var(--text-muted);">Nenhum aniversariante encontrado hoje pela API.</td></tr>';
        document.getElementById('count-aniversariantes-hoje').innerText = '0';
        return;
    }

    document.getElementById('count-aniversariantes-hoje').innerText = aniversariantesHojeData.length;

    list.innerHTML = aniversariantesHojeData.map(p => {
        return `
            <tr style="background: rgba(245, 158, 11, 0.1); border-left: 3px solid var(--accent-warning);">
                <td style="text-align: center;" class="rel-select-col"><input type="checkbox" class="rel-select" data-tipo="aniversariantes-hoje" data-id="${escapeHtml(p.phone || '')}" data-nome="${escapeHtml(p.name)}" data-telefone="${escapeHtml(p.phone || '')}" onchange="updateRelBulkBar('aniversariantes-hoje')"></td>
                <td style="font-weight: 500;">
                    <div style="display: flex; align-items: center; gap: 0.75rem;">
                        <div style="width: 32px; height: 32px; border-radius: 50%; background: rgba(245, 158, 11, 0.1); display: flex; align-items: center; justify-content: center; color: var(--accent-warning);">
                            <i class="fa-solid fa-gift"></i>
                        </div>
                        ${p.name}
                    </div>
                </td>
                <td>${formatPhone(p.phone)}</td>
                <td><span style="font-weight: 500;">${p.age} anos</span></td>
                <td style="text-align: center;">
                    ${p.contacted ?
                        `<button disabled class="btn-secondary" style="width: 100%; justify-content: center; background: rgba(255, 255, 255, 0.05); color: var(--text-muted); cursor: not-allowed; border: none; padding: 0.5rem;">
                            <i class="fa-solid fa-check"></i> Já Contactado
                        </button>` :
                        `<a href="${getWhatsAppLink(p.phone, p.name, 'aniversariante')}" onclick="registerMessageSent('${escapeHtml(p.phone || '')}', 'aniversariante', this)" target="_blank" class="btn-secondary" style="width: 100%; justify-content: center; background: rgba(16, 185, 129, 0.15); color: var(--accent-success); border-color: rgba(16, 185, 129, 0.3); text-decoration: none; padding: 0.5rem;">
                            <i class="fa-brands fa-whatsapp"></i> Parabéns
                        </a>`
                    }
                </td>
            </tr>
        `;
    }).join('');
}

function renderAniversariantesMes() {
    const list = document.getElementById('list-aniversariantes-mes');
    if (!list) return;
    resetRelBulkBar('aniversariantes-mes');

    if (aniversariantesMesData.length === 0) {
        list.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 2rem; color: var(--text-muted);">Planilha vazia ou não importada.</td></tr>';
        document.getElementById('count-aniversariantes-mes').innerText = '0';
        return;
    }

    document.getElementById('count-aniversariantes-mes').innerText = aniversariantesMesData.length;

    list.innerHTML = aniversariantesMesData.map(p => {
        const isTodayStyle = p.isToday ? 'background: rgba(16, 185, 129, 0.1); border-left: 3px solid var(--accent-success);' : '';
        const todayBadge = p.isToday ? '<span style="background: var(--accent-success); color: white; padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.7rem; margin-left: 0.5rem; font-weight: bold;">HOJE</span>' : '';

        return `
            <tr style="${isTodayStyle}">
                <td style="text-align: center;" class="rel-select-col"><input type="checkbox" class="rel-select" data-tipo="aniversariantes-mes" data-id="${escapeHtml(p.phone || '')}" data-nome="${escapeHtml(p.name)}" data-telefone="${escapeHtml(p.phone || '')}" onchange="updateRelBulkBar('aniversariantes-mes')"></td>
                <td style="font-weight: 500;">
                    <div style="display: flex; align-items: center; gap: 0.75rem;">
                        <div style="width: 32px; height: 32px; border-radius: 50%; background: rgba(245, 158, 11, 0.1); display: flex; align-items: center; justify-content: center; color: var(--accent-warning);">
                            <i class="fa-solid fa-gift"></i>
                        </div>
                        ${p.name}
                    </div>
                </td>
                <td>${formatPhone(p.phone)}</td>
                <td>${p.birthDate} ${todayBadge}</td>
                <td style="text-align: center;">
                    ${p.contacted ?
                        `<button disabled class="btn-secondary" style="width: 100%; justify-content: center; background: rgba(255, 255, 255, 0.05); color: var(--text-muted); cursor: not-allowed; border: none; padding: 0.5rem;">
                            <i class="fa-solid fa-check"></i> Já Contactado
                        </button>` :
                        `<a href="${getWhatsAppLink(p.phone, p.name, 'aniversariante')}" onclick="registerMessageSent('${escapeHtml(p.phone || '')}', 'aniversariante', this)" target="_blank" class="btn-secondary" style="width: 100%; justify-content: center; background: rgba(16, 185, 129, 0.15); color: var(--accent-success); border-color: rgba(16, 185, 129, 0.3); text-decoration: none; padding: 0.5rem;">
                            <i class="fa-brands fa-whatsapp"></i> Parabéns
                        </a>`
                    }
                </td>
            </tr>
        `;
    }).join('');
}

async function uploadNovaPlanilha(event) {
    const file = event.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('csvFile', file);

    const btnLabel = event.target.previousElementSibling;
    const oldText = btnLabel.innerHTML;
    btnLabel.innerHTML = '<span class="amicro-loader"><span></span><span></span><span></span></span> Salvando...';

    try {
        const res = await fetch('/api/aniversariantes/upload', {
            method: 'POST',
            body: formData
        });
        
        const data = await res.json();
        if (res.ok) {
            await customAlert("Planilha atualizada com sucesso!");
            aniversariantesMesFetched = false;
            fetchAniversariantesMes();
        } else {
            await customAlert("Erro ao salvar: " + (data.error || 'Desconhecido'));
        }
    } catch (e) {
        console.error(e);
        await customAlert("Erro na comunicação com o servidor.");
    } finally {
        btnLabel.innerHTML = oldText;
        event.target.value = '';
    }
}
// === LOGIN E NOTIFICAÇÕES ===
let pendingLoginPassword = null; // guardado só em memória, o tempo de completar a troca obrigatória de senha

function finishLogin(user) {
    loggedUser = user;
    localStorage.setItem('crm_user', JSON.stringify(loggedUser));
    window.__authExpiredShown = false; // sessão nova: volta a armar o detector de 401
    document.getElementById('login-overlay').classList.remove('active');

    const flyoutGestao = document.getElementById('flyout-gestao-acessos');
    if (flyoutGestao) {
        flyoutGestao.style.display = (loggedUser.role === 'admin' || loggedUser.username === 'admin') ? 'flex' : 'none';
    }
    const btnAiAgent = document.getElementById('sb-tool-ai-agent');
    if (btnAiAgent) {
        btnAiAgent.style.display = (loggedUser.role === 'admin' || loggedUser.username === 'admin') ? 'flex' : 'none';
    }

    fetchLeadsFromServer();
    fetchApiOptions();
    startNotificationPolling();
    updateHeaderProfileUI();
    loadDisplayNamesMap();
    loadAvatarMap();
    loadUnidades();
    startHeartbeat();
    startHotLeadsBadgeClock();
}

// === BADGE DE LEADS QUENTES (qualificados pela IA, esperando atendimento) ===
// Não busca nada no servidor: só relê o array "leads" (já mantido atualizado pelo
// polling/SSE do Kanban) e recalcula. Roda num relógio próprio porque a urgência
// (15min = vira "atrasado") muda com o tempo mesmo sem nenhum dado novo chegar.
const HOT_LEAD_SLA_MS = 15 * 60 * 1000;

function renderHotLeadsBadge() {
    const el = document.getElementById('hot-leads-badge');
    const textEl = document.getElementById('hot-leads-badge-text');
    if (!el || !textEl || typeof leads === 'undefined' || !Array.isArray(leads)) return;

    const quentes = leads.filter(l => l.qualificado_em);
    if (quentes.length === 0) {
        el.style.display = 'none';
        return;
    }

    const now = Date.now();
    const parseTs = (typeof parseD1TimestampMs === 'function') ? parseD1TimestampMs : (s) => new Date((s || '').replace(' ', 'T') + 'Z').getTime();
    let piorEsperaMs = 0;
    quentes.forEach(l => {
        const t = parseTs(l.qualificado_em) || now;
        piorEsperaMs = Math.max(piorEsperaMs, now - t);
    });

    const atrasado = piorEsperaMs >= HOT_LEAD_SLA_MS;

    el.style.display = 'flex';
    // Faixa de largura total, fundo cheio: vermelho forte quando atrasado,
    // laranja forte caso contrário. Texto e ícone brancos.
    el.style.background = atrasado ? '#dc2626' : '#ea580c';
    el.style.border = 'none';
    el.style.borderTop = el.style.borderBottom = '1px solid rgba(0, 0, 0, 0.18)';
    el.style.color = '#fff';
    el.style.animation = atrasado ? 'hotLeadPulse 1.5s ease-in-out infinite' : 'none';

    const plural = quentes.length > 1;
    if (quentes.length === 1 && quentes[0].nome) {
        const nome = quentes[0].nome.replace(' [MKT]', '');
        textEl.textContent = atrasado
            ? `${nome} está quente há mais de 15min sem atendimento!`
            : `${nome} está pronto(a) pra ser atendido(a)`;
    } else {
        textEl.textContent = atrasado
            ? `${quentes.length} leads quentes esperando — alguns há mais de 15min!`
            : `${quentes.length} lead${plural ? 's' : ''} quente${plural ? 's' : ''} esperando atendimento`;
    }
}

function startHotLeadsBadgeClock() {
    renderHotLeadsBadge();
    if (window._hotLeadsClock) clearInterval(window._hotLeadsClock);
    // Só recalcula a urgência com base no relógio — não bate no servidor.
    window._hotLeadsClock = setInterval(renderHotLeadsBadge, 20000);
}

// ============================================================================
// AGENTE DE IA (painel da topbar) — pergunta livre sobre a carteira de leads.
// Economia de tokens: o funil (contagem por coluna) é calculado aqui, 100% em
// memória, a partir do array "leads" que o Kanban já mantém sincronizado —
// nunca gera uma leitura nova no D1 só pra abrir o painel. O texto qualitativo
// (queixas/motivos de perda) vem de um digest cacheado no servidor, recalculado
// no máximo a cada poucas horas — o painel só consome o que já está pronto.
// ============================================================================
let aiAgentHistory = []; // {role: 'user'|'assistant', text} — só a sessão atual, nunca persistido
let aiAgentOpen = false;

function computeAiAgentFunnel() {
    if (typeof leads === 'undefined' || !Array.isArray(leads)) return {};
    const counts = {};
    leads.forEach(l => {
        const col = l.column_id || l.column || 'col-entrada';
        const label = (typeof KANBAN_COLUMNS !== 'undefined' && KANBAN_COLUMNS[col]) ? KANBAN_COLUMNS[col].label : col;
        counts[label] = (counts[label] || 0) + 1;
    });
    const quentes = leads.filter(l => l.qualificado_em).length;
    if (quentes > 0) counts['Quentes (IA) esperando atendimento'] = quentes;
    return counts;
}

function toggleAiAgentPanel() {
    if (aiAgentOpen) closeAiAgentPanel(); else openAiAgentPanel();
}

function openAiAgentPanel() {
    const panel = document.getElementById('ai-agent-panel');
    const overlay = document.getElementById('ai-agent-overlay');
    if (!panel || !overlay) return;
    overlay.style.display = 'block';
    panel.classList.add('open');
    aiAgentOpen = true;
    loadAiAgentDigestFreshness();
    const input = document.getElementById('ai-agent-input');
    if (input) setTimeout(() => input.focus(), 250);
}

function closeAiAgentPanel() {
    const panel = document.getElementById('ai-agent-panel');
    const overlay = document.getElementById('ai-agent-overlay');
    if (!panel || !overlay) return;
    panel.classList.remove('open');
    overlay.style.display = 'none';
    aiAgentOpen = false;
}

async function loadAiAgentDigestFreshness() {
    const el = document.getElementById('ai-agent-digest-freshness');
    if (!el) return;
    try {
        const res = await fetch('/api/ai-agent/digest');
        const json = await res.json();
        if (!json.last_run) { el.textContent = 'Análise: ainda não gerada'; return; }
        const ms = (typeof parseD1TimestampMs === 'function') ? parseD1TimestampMs(json.last_run) : new Date(json.last_run).getTime();
        const minAgo = Math.max(0, Math.round((Date.now() - ms) / 60000));
        const texto = minAgo < 60 ? `há ${minAgo}min` : `há ${Math.round(minAgo / 60)}h`;
        el.textContent = `Análise: ${texto}`;
    } catch (e) {
        el.textContent = 'Análise: indisponível';
    }
}

async function refreshAiAgentDigest() {
    const btn = document.getElementById('ai-agent-refresh-btn');
    if (btn) btn.disabled = true;
    try {
        const res = await fetch('/api/ai-agent/refresh', { method: 'POST' });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
            if (typeof showToast === 'function') showToast(json.error || 'Não foi possível atualizar agora.', 'danger');
            return;
        }
        if (typeof showToast === 'function') showToast('Análise atualizada.', 'success');
        loadAiAgentDigestFreshness();
    } catch (e) {
        if (typeof showToast === 'function') showToast('Erro de conexão ao atualizar a análise.', 'danger');
    } finally {
        if (btn) btn.disabled = false;
    }
}

function askAiAgentChip(pergunta) {
    const input = document.getElementById('ai-agent-input');
    if (input) input.value = pergunta;
    sendAiAgentMessage();
}

function renderAiAgentMessage(role, text) {
    const container = document.getElementById('ai-agent-messages');
    if (!container) return null;
    const emptyState = document.getElementById('ai-agent-empty-state');
    if (emptyState) emptyState.style.display = 'none';

    const div = document.createElement('div');
    div.className = `ai-agent-msg ai-agent-msg--${role}`;
    div.textContent = text;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return div;
}

function renderAiAgentLoading() {
    const container = document.getElementById('ai-agent-messages');
    if (!container) return null;
    const div = document.createElement('div');
    div.className = 'ai-agent-msg--loading';
    div.id = 'ai-agent-loading-bubble';
    div.innerHTML = '<span></span><span></span><span></span>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return div;
}

async function sendAiAgentMessage() {
    const input = document.getElementById('ai-agent-input');
    const sendBtn = document.getElementById('ai-agent-send-btn');
    if (!input) return;
    const pergunta = input.value.trim();
    if (!pergunta) return;

    input.value = '';
    if (sendBtn) sendBtn.disabled = true;
    renderAiAgentMessage('user', pergunta);
    aiAgentHistory.push({ role: 'user', text: pergunta });
    const loadingBubble = renderAiAgentLoading();

    try {
        const res = await fetch('/api/ai-agent/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pergunta,
                historico: aiAgentHistory.slice(0, -1), // sem a pergunta atual, que já vai separada
                funil: computeAiAgentFunnel()
            })
        });
        const json = await res.json().catch(() => ({}));
        if (loadingBubble) loadingBubble.remove();
        if (!res.ok) {
            renderAiAgentMessage('assistant', json.error || 'Não consegui responder agora. Tente de novo em instantes.');
            return;
        }
        renderAiAgentMessage('assistant', json.resposta || 'Não consegui gerar uma resposta.');
        aiAgentHistory.push({ role: 'assistant', text: json.resposta || '' });
        // Mantém só as últimas 6 trocas — sessão de chat curta, custo de token previsível.
        if (aiAgentHistory.length > 12) aiAgentHistory = aiAgentHistory.slice(-12);
    } catch (e) {
        if (loadingBubble) loadingBubble.remove();
        renderAiAgentMessage('assistant', 'Erro de conexão. Tente de novo.');
    } finally {
        if (sendBtn) sendBtn.disabled = false;
    }
}

// === MEU PERFIL ===
let pendingAvatarDataUrl = null;

function updateHeaderProfileUI() {
    const nameEl = document.getElementById('header-display-name');
    const topbarNameEl = document.getElementById('topbar-display-name');
    const imgEl = document.getElementById('header-avatar-img');
    const fallbackEl = document.getElementById('header-avatar-fallback');
    if (!nameEl || !loggedUser) return;

    const displayName = loggedUser.display_name || loggedUser.username;
    nameEl.textContent = displayName;
    if (topbarNameEl) topbarNameEl.textContent = displayName;

    if (loggedUser.avatar_url) {
        imgEl.src = loggedUser.avatar_url;
        imgEl.style.display = 'block';
        fallbackEl.style.display = 'none';
    } else {
        imgEl.style.display = 'none';
        fallbackEl.style.display = 'inline';
    }
}

// === PRESENÇA ONLINE DA EQUIPE ===
function startHeartbeat() {
    if (window.heartbeatInterval) return;
    fetch('/api/heartbeat', { method: 'POST' }).catch(() => {});
    window.heartbeatInterval = setInterval(() => {
        if (loggedUser) fetch('/api/heartbeat', { method: 'POST' }).catch(() => {});
    }, 30000);
}

function formatLastSeen(lastSeenAt) {
    if (!lastSeenAt) return 'nunca visto';
    const d = parseSqlDate(lastSeenAt);
    if (!d) return 'nunca visto';
    const diffMs = Date.now() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'agora mesmo';
    if (diffMin < 60) return `há ${diffMin} min`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `há ${diffH}h`;
    const diffD = Math.floor(diffH / 24);
    return `há ${diffD}d`;
}

async function openEquipeModal() {
    const modal = document.getElementById('modalEquipe');
    if (modal) modal.classList.add('active');
    const listEl = document.getElementById('equipe-list');
    if (!listEl) return;
    listEl.innerHTML = '<div style="text-align:center; padding:1.5rem; color: var(--text-muted);"><span class="amicro-loader"><span></span><span></span><span></span></span> Carregando...</div>';

    try {
        const res = await fetch('/api/users/presence');
        const data = await res.json();
        if (!res.ok || !Array.isArray(data)) throw new Error(data.error || 'Erro ao carregar equipe.');

        data.sort((a, b) => (b.online - a.online) || a.display_name.localeCompare(b.display_name));

        listEl.innerHTML = data.map(u => {
            const dotColor = u.online ? 'var(--accent-success)' : 'var(--sb-danger)';
            const statusText = u.online ? 'Online' : formatLastSeen(u.last_seen_at);
            const avatarHTML = u.avatar_url
                ? `<img src="${u.avatar_url}" alt="" style="width: 34px; height: 34px; border-radius: 50%; object-fit: cover;">`
                : `<div style="width: 34px; height: 34px; border-radius: 50%; background: var(--header-btn-bg); display: flex; align-items: center; justify-content: center;"><i class="fa-solid fa-user" style="color: var(--text-muted); font-size: 0.9rem;"></i></div>`;

            return `<div style="display: flex; align-items: center; gap: 0.75rem; padding: 0.6rem 0.5rem;">
                <div style="position: relative; flex-shrink: 0;">
                    ${avatarHTML}
                    <span style="position: absolute; bottom: -1px; right: -1px; width: 10px; height: 10px; border-radius: 50%; background: ${dotColor}; border: 2px solid var(--bg-card);"></span>
                </div>
                <div style="flex: 1; min-width: 0;">
                    <div style="font-weight: 600; color: var(--text-main); font-size: 0.88rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(u.display_name)}</div>
                    <div style="font-size: 0.75rem; color: ${u.online ? 'var(--accent-success)' : 'var(--text-muted)'};">${statusText}</div>
                </div>
            </div>`;
        }).join('') || '<div style="text-align:center; padding:1.5rem; color: var(--text-muted);">Nenhum usuário encontrado.</div>';
    } catch (e) {
        listEl.innerHTML = '<div style="text-align:center; padding:1.5rem; color: var(--accent-danger);">Falha ao carregar a equipe.</div>';
    }
}

function toggleUserMenu(event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById('user-flyout-menu');
    if (menu) menu.classList.toggle('open');
}

function closeUserMenu() {
    const menu = document.getElementById('user-flyout-menu');
    if (menu) menu.classList.remove('open');
}

document.addEventListener('click', (e) => {
    const menu = document.getElementById('user-flyout-menu');
    if (menu && menu.classList.contains('open') && !menu.contains(e.target) && !e.target.closest('.user-badge')) {
        menu.classList.remove('open');
    }
});

async function loadDisplayNamesMap() {
    try {
        const res = await fetch('/api/users/display-names');
        if (res.ok) {
            displayNamesMap = await res.json();
            renderBoard();
        }
    } catch (e) {}
}

async function loadAvatarMap() {
    try {
        const res = await fetch('/api/users/presence');
        const data = await res.json();
        if (res.ok && Array.isArray(data)) {
            avatarMap = {};
            data.forEach(u => { avatarMap[u.username] = u.avatar_url || null; });
            renderBoard();
        }
    } catch (e) {}
}

function resolveDisplayName(username) {
    if (!username) return '';
    return (displayNamesMap && displayNamesMap[username]) || username;
}

function openMeuPerfilModal() {
    if (!loggedUser) return;
    pendingAvatarDataUrl = null;
    cancelAvatarCrop(); // garante que o editor de posicionamento não fica aberto de uma vez anterior

    document.getElementById('perfil-username-label').textContent = '@' + loggedUser.username;
    document.getElementById('perfil-display-name').value = loggedUser.display_name || '';
    document.getElementById('perfil-senha-atual').value = '';
    document.getElementById('perfil-senha-nova').value = '';
    const errEl = document.getElementById('perfil-senha-error');
    if (errEl) errEl.style.display = 'none';

    const imgEl = document.getElementById('perfil-avatar-preview');
    const fallbackEl = document.getElementById('perfil-avatar-fallback');
    if (loggedUser.avatar_url) {
        imgEl.src = loggedUser.avatar_url;
        imgEl.style.display = 'block';
        fallbackEl.style.display = 'none';
    } else {
        imgEl.style.display = 'none';
        fallbackEl.style.display = 'inline';
    }

    document.getElementById('modalMeuPerfil').classList.add('active');
}

function handlePerfilAvatarChange(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => openAvatarCropEditor(img);
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
    event.target.value = ''; // permite escolher o mesmo arquivo de novo depois, se quiser reposicionar do zero
}

// ============================================
// EDITOR DE POSICIONAMENTO DA FOTO DE PERFIL
// (arrastar pra mover + slider pra zoom, antes de salvar)
// ============================================
const CROP_VIEWPORT_SIZE = 220;
const AVATAR_OUTPUT_SIZE = 256;
let avatarCropState = null;

function openAvatarCropEditor(img) {
    // minScale garante que a imagem sempre cobre o viewport inteiro (sem sobrar fundo preto)
    const minScale = Math.max(CROP_VIEWPORT_SIZE / img.width, CROP_VIEWPORT_SIZE / img.height);
    avatarCropState = { img, minScale, scale: minScale, offsetX: 0, offsetY: 0 };

    const imgEl = document.getElementById('perfil-crop-image');
    imgEl.src = img.src;

    const zoomSlider = document.getElementById('perfil-crop-zoom');
    if (zoomSlider) zoomSlider.value = 100;

    document.getElementById('perfil-avatar-display').style.display = 'none';
    document.getElementById('perfil-avatar-cropper').style.display = 'flex';

    applyAvatarCropTransform();
    wireAvatarCropDragHandlers();
}

function applyAvatarCropTransform() {
    if (!avatarCropState) return;
    const { img, scale, offsetX, offsetY } = avatarCropState;
    const w = img.width * scale;
    const h = img.height * scale;
    const imgEl = document.getElementById('perfil-crop-image');
    imgEl.style.width = w + 'px';
    imgEl.style.height = h + 'px';
    imgEl.style.left = ((CROP_VIEWPORT_SIZE - w) / 2 + offsetX) + 'px';
    imgEl.style.top = ((CROP_VIEWPORT_SIZE - h) / 2 + offsetY) + 'px';
}

// Não deixa arrastar a imagem pra além da borda do círculo (sempre cobrindo o viewport)
function clampAvatarCropOffset() {
    const { img, scale } = avatarCropState;
    const w = img.width * scale;
    const h = img.height * scale;
    const maxOffsetX = Math.max(0, (w - CROP_VIEWPORT_SIZE) / 2);
    const maxOffsetY = Math.max(0, (h - CROP_VIEWPORT_SIZE) / 2);
    avatarCropState.offsetX = Math.min(maxOffsetX, Math.max(-maxOffsetX, avatarCropState.offsetX));
    avatarCropState.offsetY = Math.min(maxOffsetY, Math.max(-maxOffsetY, avatarCropState.offsetY));
}

function onCropZoomChange(sliderValue) {
    if (!avatarCropState) return;
    const factor = sliderValue / 100; // slider 100–300 -> 1x a 3x sobre o zoom mínimo
    avatarCropState.scale = avatarCropState.minScale * factor;
    clampAvatarCropOffset();
    applyAvatarCropTransform();
}

function wireAvatarCropDragHandlers() {
    const viewport = document.getElementById('perfil-crop-viewport');
    if (!viewport || viewport._cropHandlersWired) return;
    viewport._cropHandlersWired = true;

    let dragging = false;
    let startX = 0, startY = 0, startOffsetX = 0, startOffsetY = 0;

    const getPoint = (e) => (e.touches ? e.touches[0] : e);

    const onPointerDown = (e) => {
        if (!avatarCropState) return;
        dragging = true;
        viewport.style.cursor = 'grabbing';
        const p = getPoint(e);
        startX = p.clientX;
        startY = p.clientY;
        startOffsetX = avatarCropState.offsetX;
        startOffsetY = avatarCropState.offsetY;
        e.preventDefault();
    };
    const onPointerMove = (e) => {
        if (!dragging || !avatarCropState) return;
        const p = getPoint(e);
        avatarCropState.offsetX = startOffsetX + (p.clientX - startX);
        avatarCropState.offsetY = startOffsetY + (p.clientY - startY);
        clampAvatarCropOffset();
        applyAvatarCropTransform();
        e.preventDefault();
    };
    const onPointerUp = () => {
        dragging = false;
        viewport.style.cursor = 'grab';
    };

    viewport.addEventListener('mousedown', onPointerDown);
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);
    viewport.addEventListener('touchstart', onPointerDown, { passive: false });
    window.addEventListener('touchmove', onPointerMove, { passive: false });
    window.addEventListener('touchend', onPointerUp);
}

function cancelAvatarCrop() {
    avatarCropState = null;
    const cropperEl = document.getElementById('perfil-avatar-cropper');
    const displayEl = document.getElementById('perfil-avatar-display');
    if (cropperEl) cropperEl.style.display = 'none';
    if (displayEl) displayEl.style.display = 'flex';
    const fileInput = document.getElementById('perfil-avatar-input');
    if (fileInput) fileInput.value = '';
}

function confirmAvatarCrop() {
    if (!avatarCropState) return;
    const { img, scale, offsetX, offsetY } = avatarCropState;

    // Reproduz exatamente o enquadramento visto no editor, só que na resolução final de saída
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_OUTPUT_SIZE;
    canvas.height = AVATAR_OUTPUT_SIZE;
    const ctx = canvas.getContext('2d');

    const outputRatio = AVATAR_OUTPUT_SIZE / CROP_VIEWPORT_SIZE;
    const w = img.width * scale * outputRatio;
    const h = img.height * scale * outputRatio;
    const left = ((CROP_VIEWPORT_SIZE - img.width * scale) / 2 + offsetX) * outputRatio;
    const top = ((CROP_VIEWPORT_SIZE - img.height * scale) / 2 + offsetY) * outputRatio;

    ctx.drawImage(img, left, top, w, h);
    pendingAvatarDataUrl = canvas.toDataURL('image/jpeg', 0.85);

    const imgEl = document.getElementById('perfil-avatar-preview');
    const fallbackEl = document.getElementById('perfil-avatar-fallback');
    imgEl.src = pendingAvatarDataUrl;
    imgEl.style.display = 'block';
    fallbackEl.style.display = 'none';

    avatarCropState = null;
    document.getElementById('perfil-avatar-cropper').style.display = 'none';
    document.getElementById('perfil-avatar-display').style.display = 'flex';
}

async function savePerfil() {
    const displayName = (document.getElementById('perfil-display-name').value || '').trim();
    const payload = { display_name: displayName };
    if (pendingAvatarDataUrl) payload.avatar_url = pendingAvatarDataUrl;

    try {
        const res = await fetch('/api/me', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            customAlert(data.error || 'Erro ao salvar perfil.');
            return;
        }

        loggedUser.display_name = displayName;
        if (pendingAvatarDataUrl) loggedUser.avatar_url = pendingAvatarDataUrl;
        localStorage.setItem('crm_user', JSON.stringify(loggedUser));
        updateHeaderProfileUI();
        loadDisplayNamesMap();
        renderBoard();
        closeModals();
    } catch (e) {
        customAlert('Falha de conexão ao salvar perfil.');
    }
}

async function changeMyPasswordFromProfile() {
    const errEl = document.getElementById('perfil-senha-error');
    const currentPassword = document.getElementById('perfil-senha-atual').value || '';
    const newPassword = (document.getElementById('perfil-senha-nova').value || '').trim();

    if (errEl) errEl.style.display = 'none';

    if (newPassword.length < 6) {
        if (errEl) { errEl.textContent = 'A nova senha precisa ter pelo menos 6 caracteres.'; errEl.style.display = 'block'; }
        return;
    }

    try {
        const res = await fetch('/api/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword, newPassword })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            if (errEl) { errEl.textContent = data.error || 'Erro ao trocar a senha.'; errEl.style.display = 'block'; }
            return;
        }
        document.getElementById('perfil-senha-atual').value = '';
        document.getElementById('perfil-senha-nova').value = '';
        customAlert('Senha alterada com sucesso!');
    } catch (e) {
        if (errEl) { errEl.textContent = 'Falha de conexão.'; errEl.style.display = 'block'; }
    }
}

async function performLogin() {
    const u = (document.getElementById('login-username').value || '').trim().toLowerCase();
    const p = (document.getElementById('login-password').value || '').trim();
    const badge = document.getElementById('login-error-badge');
    const badgeText = document.getElementById('login-error-text');
    const submitBtn = document.getElementById('login-submit');

    if (badge) badge.style.display = 'none';
    submitBtn?.classList.add('is-loading');

    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({username: u, password: p})
        });

        let data = {};
        try { data = await res.json(); } catch(e) {}

        if (res.ok && data.success) {
            if (data.mustChangePassword) {
                pendingLoginPassword = p;
                document.getElementById('login-fields').style.display = 'none';
                document.getElementById('force-change-fields').style.display = 'flex';
                return;
            }
            finishLogin(data.user);
        } else {
            if (badge) {
                badge.style.display = 'flex';
                badgeText.innerText = data.error || 'Erro interno de servidor. Tente novamente.';
            }
        }
    } catch(e) {
        if (badge) {
            badge.style.display = 'flex';
            badgeText.innerText = 'Falha de conexão com o servidor.';
        }
    } finally {
        submitBtn?.classList.remove('is-loading');
    }
}

async function submitForceChangePassword() {
    const badge = document.getElementById('login-error-badge');
    const badgeText = document.getElementById('login-error-text');
    const submitBtn = document.getElementById('force-change-submit');
    if (badge) badge.style.display = 'none';

    const newPassword = (document.getElementById('force-new-password').value || '').trim();
    const confirmPassword = (document.getElementById('force-confirm-password').value || '').trim();

    if (newPassword.length < 6) {
        if (badge) { badge.style.display = 'flex'; badgeText.innerText = 'A nova senha precisa ter pelo menos 6 caracteres.'; }
        return;
    }
    if (newPassword !== confirmPassword) {
        if (badge) { badge.style.display = 'flex'; badgeText.innerText = 'As senhas não coincidem.'; }
        return;
    }

    submitBtn?.classList.add('is-loading');
    try {
        const res = await fetch('/api/change-password', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ currentPassword: pendingLoginPassword, newPassword })
        });
        let data = {};
        try { data = await res.json(); } catch(e) {}

        if (res.ok && data.success) {
            pendingLoginPassword = null;
            document.getElementById('force-change-fields').style.display = 'none';
            document.getElementById('login-fields').style.display = 'flex';
            // Faz login de novo já com a senha nova para abrir a sessão normalmente
            document.getElementById('login-password').value = newPassword;
            await performLogin();
        } else {
            if (badge) { badge.style.display = 'flex'; badgeText.innerText = data.error || 'Erro ao trocar a senha.'; }
        }
    } catch(e) {
        if (badge) { badge.style.display = 'flex'; badgeText.innerText = 'Falha de conexão com o servidor.'; }
    } finally {
        submitBtn?.classList.remove('is-loading');
    }
}

let seenNotifications = new Set();
let unreadNotifications = 0;
let isFirstLoad = true;

function startNotificationPolling() {
    // Busca inicial rápida, depois a cada 60s. Antes era 10s: sozinho respondia
    // por ~47% da cota diária de rows_read do D1 (avisos de login/lembrete não
    // precisam de latência baixa).
    if (isFirstLoad) {
        fetchNotifications(true);
    } else {
        fetchNotifications(false);
    }

    if (window.notifPollInterval) clearInterval(window.notifPollInterval);
    window.notifPollInterval = setInterval(() => {
        fetchNotifications(false);
    }, 60000);
}

async function logout() {
    localStorage.removeItem('crm_user');
    try {
        await fetch('/api/logout', { method: 'POST' });
    } catch (e) {}
    location.reload();
}

async function fetchNotifications() {
    try {
        const res = await fetch('/api/notifications');
        const data = await res.json();
        const listContainer = document.getElementById('notifications-list');
        
        // Os mais novos vêm primeiro (DESC no backend), vamos reverter pra mostrar em ordem pro user
        data.reverse().forEach(n => {
            if (!seenNotifications.has(n.id)) {
                seenNotifications.add(n.id);
                // Apenas preenchemos a lista (sem popup toast)
                
                // Remove o placeholder se existir
                if (listContainer && listContainer.innerHTML.includes('Nenhuma notificação')) {
                    listContainer.innerHTML = '';
                }
                
                // Adiciona na lista do menu
                if (listContainer) {
                    let timeStr = '';
                    if (n.created_at) {
                        if (n.created_at.includes('T')) timeStr = n.created_at.split('T')[1].slice(0,5);
                        else timeStr = n.created_at.split(' ')[1].slice(0,5);
                    }
                    
                    // Tipo da notificação (só pra cor/ícone) — inferido da mensagem.
                    let ntype = 'success';
                    if (/^\s*💰/.test(n.message) || /\boportunidade\b/i.test(n.message)) ntype = 'opp';
                    else if (/novo lead/i.test(n.message)) ntype = 'lead';
                    else if (/qualificad|\bIA\b/i.test(n.message)) ntype = 'ai';
                    else if (/entrou no sistema|saiu do sistema|entrou na conversa/i.test(n.message)) ntype = 'user';

                    // O ícone tipado já comunica o status — tira emoji/traço do começo da frase.
                    let cleanMsg = n.message;
                    try { cleanMsg = n.message.replace(/^[^\p{L}\p{N}("']+/u, '').trim() || n.message; } catch (e) {}

                    const typeIcon = ntype === 'opp' ? 'fa-sack-dollar'
                        : ntype === 'ai' ? 'fa-robot'
                        : ntype === 'lead' ? 'fa-user-plus'
                        : ntype === 'user' ? 'fa-right-to-bracket'
                        : 'fa-check';

                    const iconHTML = n.avatar_url
                        ? `<img class="notif-avatar" src="${n.avatar_url}" alt="">`
                        : `<span class="notif-icon notif-icon--${ntype}"><i class="fa-solid ${typeIcon}"></i></span>`;

                    const item = document.createElement('div');
                    item.className = 'notif-item';
                    const isHandoff = !!n.action_phone;
                    if (isHandoff) {
                        item.classList.add('notif-item--priority', 'notif-item--click');
                        item.setAttribute('role', 'button');
                        item.tabIndex = 0;
                        const go = () => notifOpenChat(n.action_phone);
                        item.addEventListener('click', go);
                        item.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
                    }
                    item.innerHTML = `${iconHTML}<div class="notif-body"><span class="notif-time">${timeStr}</span><p class="notif-text">${escapeHtml(cleanMsg)}</p>${isHandoff ? '<span class="notif-cta">Abrir conversa →</span>' : ''}</div>`;
                    listContainer.prepend(item);

                    if (!isFirstLoad && isHandoff) playQualifiedChime();
                }

                if (!isFirstLoad) {
                    unreadNotifications++;
                    const badge = document.getElementById('nav-notification-badge');
                    if (badge) {
                        badge.innerText = unreadNotifications;
                        badge.style.display = 'flex';
                        badge.classList.remove('badge-popping');
                        void badge.offsetWidth;
                        badge.classList.add('badge-popping');
                        badge.addEventListener('animationend', () => badge.classList.remove('badge-popping'), { once: true });
                    }
                }
            }
        });
        isFirstLoad = false;
    } catch(e) {}
}

// Clique numa notificação de handoff → abre a conversa daquele lead.
function notifOpenChat(phone) {
    if (!phone) return;
    try {
        const menu = document.getElementById('notifications-dropdown');
        if (menu) menu.style.display = 'none';
        if (typeof switchTab === 'function') switchTab('chat');
        let name = 'Lead';
        try {
            const c = (typeof allChatsList !== 'undefined' && Array.isArray(allChatsList))
                ? allChatsList.find(x => typeof isSamePhone === 'function' && isSamePhone(x.phone, phone))
                : null;
            if (c && c.nome) name = c.nome;
        } catch (e) {}
        if (typeof openChat === 'function') openChat(phone, name);
    } catch (e) { console.error('notifOpenChat', e); }
}

// Toque distinto quando um lead é qualificado pela IA (só nesse tipo).
function playQualifiedChime() {
    try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const ctx = new AC();
        const now = ctx.currentTime;
        [880, 1174.66].forEach((f, i) => {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.type = 'sine'; o.frequency.value = f;
            const t0 = now + i * 0.15;
            g.gain.setValueAtTime(0.0001, t0);
            g.gain.exponentialRampToValueAtTime(0.14, t0 + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.34);
            o.connect(g); g.connect(ctx.destination);
            o.start(t0); o.stop(t0 + 0.36);
        });
        setTimeout(() => { try { ctx.close(); } catch (e) {} }, 900);
    } catch (e) {}
}

function toggleNotificationsMenu(event) {
    const menu = document.getElementById('notifications-dropdown');
    if (!menu) return;

    const opening = menu.style.display === 'none' || !menu.style.display;
    if (opening) {
        // Vira filho direto do <body> na primeira vez que abre — assim nunca mais
        // fica preso/coberto por causa de overflow ou z-index de algum ancestral
        // (já rodamos nisso mais de uma vez com o menu dentro da sidebar/topbar).
        if (menu.parentElement !== document.body) {
            document.body.appendChild(menu);
        }

        const btn = event && event.currentTarget ? event.currentTarget.closest('button, .dropdown') : document.querySelector('.sb-icon-btn[title="Notificações"]');
        const anchorEl = btn || document.querySelector('.sb-icon-btn[title="Notificações"]');
        const anchor = anchorEl ? anchorEl.getBoundingClientRect() : { left: 20, right: 60, bottom: 60 };

        // Cresce pra direita a partir do sino (não pra esquerda — senão, com o sino
        // perto da sidebar, o painel de 320px voltava a cobrir a própria sidebar).
        // Com limites pra nunca estourar nenhuma borda da tela.
        const panelWidth = 340;
        const margin = 12;
        let left = anchor.left;
        if (left + panelWidth > window.innerWidth - margin) {
            left = window.innerWidth - panelWidth - margin;
        }
        if (left < margin) left = margin;

        menu.style.position = 'fixed';
        menu.style.left = Math.round(left) + 'px';
        menu.style.right = 'auto';
        menu.style.top = Math.round(anchor.bottom + 10) + 'px';
        menu.style.bottom = 'auto';
        menu.style.transform = 'none';
        menu.style.zIndex = '99999';
        menu.style.display = 'block';
    } else {
        menu.style.display = 'none';
    }
}

// Fecha o painel de notificações ao clicar fora dele (ou apertar Esc).
document.addEventListener('click', (e) => {
    const menu = document.getElementById('notifications-dropdown');
    if (!menu || menu.style.display === 'none' || !menu.style.display) return;
    if (menu.contains(e.target)) return;
    // O próprio sino já abre/fecha pelo toggle — não interferir.
    if (e.target.closest('.sb-icon-btn[title="Notificações"]')) return;
    menu.style.display = 'none';
});

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const menu = document.getElementById('notifications-dropdown');
    if (menu && menu.style.display && menu.style.display !== 'none') {
        menu.style.display = 'none';
    }
});

function clearNotificationsBadge() {
    unreadNotifications = 0;
    const badge = document.getElementById('nav-notification-badge');
    if (badge) {
        badge.innerText = '0';
        badge.style.display = 'none';
    }
}

async function clearAllNotifications() {
    try {
        await fetch('/api/clear-notif', { method: 'POST' });
        const listContainer = document.getElementById('notifications-list');
        if (listContainer) {
            listContainer.innerHTML = '<div class="notif-empty">Nenhuma notificação ainda.</div>';
        }
        seenNotifications.clear();
        clearNotificationsBadge();
    } catch(e) {}
}

// ============================================
// MODAIS CUSTOMIZADOS (ALERTS E CONFIRMS)
// ============================================

window.customAlert = function(message, title = 'Aviso') {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'custom-modal-overlay';
        overlay.innerHTML = `
            <div class="custom-modal-box">
                <div class="custom-modal-title"><i class="fa-solid fa-circle-exclamation" style="color: var(--accent-warning);"></i> ${title}</div>
                <div class="custom-modal-message">${message}</div>
                <div class="custom-modal-actions">
                    <button class="btn-primary" id="cm-ok-btn">OK</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        document.getElementById('cm-ok-btn').addEventListener('click', () => {
            overlay.remove();
            resolve();
        });
    });
};

window.customConfirm = function(message, title = 'Confirmação') {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'custom-modal-overlay';
        overlay.innerHTML = `
            <div class="custom-modal-box">
                <div class="custom-modal-title"><i class="fa-solid fa-circle-question" style="color: var(--accent-info);"></i> ${title}</div>
                <div class="custom-modal-message">${message}</div>
                <div class="custom-modal-actions">
                    <button class="btn-secondary" id="cm-cancel-btn">Cancelar</button>
                    <button class="btn-primary" id="cm-confirm-btn" style="background: var(--accent-danger); border-color: var(--accent-danger);">Confirmar</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        document.getElementById('cm-confirm-btn').addEventListener('click', () => {
            overlay.remove();
            resolve(true);
        });
        document.getElementById('cm-cancel-btn').addEventListener('click', () => {
            overlay.remove();
            resolve(false);
        });
    });
};

// Substitui o window.prompt() nativo (que não tem a identidade do site).
// Resolve com a string digitada, ou null se o usuário cancelar.
window.customPrompt = function(message, defaultValue = '', title = 'Digite') {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'custom-modal-overlay';
        overlay.innerHTML = `
            <div class="custom-modal-box">
                <div class="custom-modal-title"><i class="fa-solid fa-pen" style="color: var(--accent-primary);"></i> ${escapeHtml(title)}</div>
                <div class="custom-modal-message">${escapeHtml(message)}</div>
                <input type="text" class="custom-modal-input" id="cm-prompt-input">
                <div class="custom-modal-actions">
                    <button class="btn-secondary" id="cm-prompt-cancel">Cancelar</button>
                    <button class="btn-primary" id="cm-prompt-ok">OK</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        const input = document.getElementById('cm-prompt-input');
        input.value = defaultValue == null ? '' : String(defaultValue);
        const done = (val) => { overlay.remove(); document.removeEventListener('keydown', onKey, true); resolve(val); };
        const onKey = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); done(input.value); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
        };
        document.addEventListener('keydown', onKey, true);
        document.getElementById('cm-prompt-ok').addEventListener('click', () => done(input.value));
        document.getElementById('cm-prompt-cancel').addEventListener('click', () => done(null));
        setTimeout(() => { input.focus(); input.select(); }, 30);
    });
};

const airDatepickerLocalePt = {
    days: ['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'],
    daysShort: ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'],
    daysMin: ['Do','Se','Te','Qu','Qu','Se','Sa'],
    months: ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'],
    monthsShort: ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'],
    today: 'Hoje', clear: 'Limpar', dateFormat: 'dd/MM/yyyy', timeFormat: 'HH:mm', firstDay: 0
};

const initAirDatepicker = () => {
    if (typeof AirDatepicker === "undefined") return;
    document.querySelectorAll('input[type=date]').forEach(input => {
        if (input._adpInstance) return;
        input._adpInstance = new AirDatepicker(input, {
            locale: airDatepickerLocalePt,
            dateFormat: 'yyyy-MM-dd',
            autoClose: true,
            onSelect({ formattedDate, datepicker }) {
                const onChangeAttr = datepicker.$el.getAttribute('onchange');
                if (onChangeAttr) {
                    const executableStr = onChangeAttr.replace(/this\.value/g, "'" + formattedDate + "'");
                    try { eval(executableStr); } catch(e) { console.error('AirDatepicker onchange error:', e); }
                } else {
                    datepicker.$el.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        });
        // Prevent browser's native date picker from opening alongside Air Datepicker
        input.type = 'text';
        input.readOnly = true;
    });
};
window._initAirDatepicker = initAirDatepicker;
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAirDatepicker);
} else {
    initAirDatepicker();
}

// Fecha qualquer Air Datepicker aberto (usado ao clicar fora e ao trocar de aba)
window.closeAllAirDatepickers = () => {
    document.querySelectorAll('input').forEach(inp => {
        if (inp._adpInstance && inp._adpInstance.visible) inp._adpInstance.hide();
    });
};

// Clicar fora do calendário (ou do botão que o abre) fecha o datepicker.
// O Air Datepicker não fecha sozinho quando é aberto via .show() programático.
document.addEventListener('mousedown', (e) => {
    if (e.target.closest('.air-datepicker')) return;
    if (e.target.closest('[data-adp-trigger]')) return;
    window.closeAllAirDatepickers();
}, true);

// === DASHBOARD PRESET / DATE-RANGE HELPERS ===
let dashCustomRange = null; // { start: Date, end: Date } or null
let dashActivePeriod = 'mes'; // 'mes' | 'trimestre' | 'ano' | 'tudo' | 'custom'
let dashFpInstance = null;

function setDashPreset(btn, preset) {
    dashCustomRange = null;
    dashActivePeriod = preset;

    // Reset custom input
    const input = document.getElementById('dash-daterange');
    const clearBtn = document.getElementById('dash-daterange-clear');
    if (input) { input.value = ''; input.placeholder = 'Período personalizado'; }
    if (clearBtn) clearBtn.style.display = 'none';
    if (dashFpInstance) dashFpInstance.clear();

    // Highlight active preset
    document.querySelectorAll('.dash-preset-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');

    renderDashboard();
}

function openDashDatepicker(inputEl) {
    if (dashFpInstance) { dashFpInstance.show(); return; }
    dashFpInstance = new AirDatepicker(inputEl, {
        locale: airDatepickerLocalePt,
        dateFormat: 'dd/MM/yyyy',
        range: true,
        multipleDatesSeparator: ' – ',
        onSelect({ date }) {
            if (Array.isArray(date) && date.length === 2) {
                dashCustomRange = { start: date[0], end: date[1] };
                dashActivePeriod = 'custom';
                document.querySelectorAll('.dash-preset-btn').forEach(b => b.classList.remove('active'));
                const clearBtn = document.getElementById('dash-daterange-clear');
                if (clearBtn) clearBtn.style.display = '';
                renderDashboard();
            }
        }
    });
    dashFpInstance.show();
}

function clearDashCustomRange() {
    dashCustomRange = null;
    dashActivePeriod = 'mes';
    if (dashFpInstance) dashFpInstance.clear();
    const input = document.getElementById('dash-daterange');
    const clearBtn = document.getElementById('dash-daterange-clear');
    if (input) { input.value = ''; input.placeholder = 'Período personalizado'; }
    if (clearBtn) clearBtn.style.display = 'none';

    // Re-activate Mês button
    const mesBtn = document.querySelector('.dash-preset-btn[data-preset="mes"]');
    if (mesBtn) {
        document.querySelectorAll('.dash-preset-btn').forEach(b => b.classList.remove('active'));
        mesBtn.classList.add('active');
    }
    renderDashboard();
}

// === DASHBOARD RESPONSE METRICS ===
let dashboardResponseMetrics = {};

async function loadDashboardResponseMetrics() {
    try {
        const res = await fetch('/api/whatsapp/response-metrics');
        const json = await res.json();
        dashboardResponseMetrics = json.success && json.data ? json.data : {};
    } catch (e) {
        dashboardResponseMetrics = {};
    }
}

function formatResponseTime(minutes) {
    if (!Number.isFinite(minutes)) return '--';
    if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min`;
    const hours = minutes / 60;
    if (hours < 24) return `${hours.toFixed(1).replace('.', ',')} h`;
    return `${(hours / 24).toFixed(1).replace('.', ',')} d`;
}

const DASH_LAYOUT_STORAGE_KEY = 'crm-dashboard-layout-v3';
// Layout "padrão" definido pelo usuário — quando existe, "Restaurar" volta pra
// ele em vez do arranjo original de fábrica (dataset.originalIndex).
const DASH_LAYOUT_DEFAULT_KEY = 'crm-dashboard-layout-default-v3';
let dashboardCustomizerActive = false;
let dashboardResizing = null;
const DASHBOARD_GRID_ROW_HEIGHT = 80;
// Trilha bem fina de propósito: cada card ocupa um número inteiro de trilhas
// (arredondado pra cima), então a trilha maior = mais folga sobrando entre o
// fim do card e a próxima linha. Com 8px essa folga ficava visível (vertical
// maior que o gap horizontal); com 2px a folga máxima é imperceptível.
const DASHBOARD_LAYOUT_ROW_HEIGHT = 2;

function getDashboardGrid() {
    return document.querySelector('.dash-layout-canvas');
}

function getDashboardCards() {
    const grid = getDashboardGrid();
    return grid ? Array.from(grid.querySelectorAll('.dash-kpi-card, .dash-layout-card')) : [];
}

function getDashboardCardKey(card) {
    if (card.dataset.dashKey) return card.dataset.dashKey;
    const value = card.querySelector('[id^="dash-"]');
    return value ? value.id : null;
}

function getDefaultDashboardSpan(index, card) {
    const key = card ? getDashboardCardKey(card) : null;
    if (key === 'goal' || key === 'leads-chart' || key === 'ranking') return key === 'goal' ? 4 : 3;
    if (key === 'funnel-chart' || key === 'origin-chart') return 1;
    return [4, 5, 10].includes(index) ? 2 : 1;
}

function updateDashboardCardScale(card) {
    const span = Number(card.dataset.layoutSpan) || 1;
    const height = Number(card.dataset.layoutHeight) || card.getBoundingClientRect().height || DASHBOARD_GRID_ROW_HEIGHT;
    const heightUnits = Math.max(1, height / DASHBOARD_GRID_ROW_HEIGHT);
    const scale = Math.max(0.8, Math.min(1.8, (span + heightUnits) / 2));
    card.style.setProperty('--dash-number-scale', scale.toFixed(2));
    card.classList.toggle('dash-card-compact', heightUnits <= 1);
    card.classList.toggle('dash-card-square', span === 1 && heightUnits <= 1);
}

function readDashboardLayout(storageKey = DASH_LAYOUT_STORAGE_KEY) {
    try {
        const layout = JSON.parse(localStorage.getItem(storageKey));
        return layout && Array.isArray(layout.cards) ? layout : null;
    } catch (e) {
        return null;
    }
}

function captureCurrentDashboardLayout() {
    return {
        cards: getDashboardCards().map((card, index) => ({
            key: getDashboardCardKey(card),
            span: Number(card.dataset.layoutSpan) || getDefaultDashboardSpan(index, card),
            height: Number(card.dataset.layoutHeight) || null,
            hidden: card.dataset.hidden === 'true'
        })).filter(card => card.key)
    };
}

function saveDashboardLayout() {
    localStorage.setItem(DASH_LAYOUT_STORAGE_KEY, JSON.stringify(captureCurrentDashboardLayout()));
}

// Layout padrão do dashboard, compartilhado no servidor (crm_settings) — antes
// "Definir como Padrão" só gravava no localStorage de quem clicava, então cada
// atendente via um padrão diferente (ou nenhum). Guardado em cache aqui pra
// applyDashboardLayout()/resetDashboardLayout() não precisarem esperar rede
// toda vez que o dashboard é aberto.
let cachedServerDashboardDefault = null;

async function loadServerDashboardDefault() {
    try {
        const res = await fetch('/api/settings/dashboard-layout');
        const json = await res.json();
        cachedServerDashboardDefault = (json.layout && Array.isArray(json.layout.cards)) ? json.layout : null;
    } catch (e) {
        console.error('Erro ao buscar layout padrão do dashboard:', e);
        cachedServerDashboardDefault = null;
    }
}

// Grava o arranjo atual como o novo padrão pra TODO MUNDO (servidor) — "Restaurar"
// passa a voltar pra este estado em vez do arranjo original de fábrica, pra
// qualquer atendente que ainda não tenha personalizado o próprio dashboard.
async function setDashboardLayoutAsDefault() {
    const layout = captureCurrentDashboardLayout();
    localStorage.setItem(DASH_LAYOUT_DEFAULT_KEY, JSON.stringify(layout)); // cache local imediato
    try {
        const res = await fetch('/api/settings/dashboard-layout', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ layout })
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Erro ao salvar no servidor');
        cachedServerDashboardDefault = layout;
        await customAlert('Layout definido como padrão para todos os atendentes!', 'Padrão Salvo');
    } catch (e) {
        console.error('Erro ao salvar layout padrão no servidor:', e);
        await customAlert('O layout ficou salvo só neste navegador — não foi possível sincronizar com o servidor: ' + e.message, 'Aviso');
    }
}

function autoPackDashboardCards() {
    const cards = getDashboardCards();
    cards.forEach((card, index) => {
        const span = Math.max(1, Math.min(6, Number(card.dataset.layoutSpan) || getDefaultDashboardSpan(index, card)));
        card.dataset.layoutSpan = span;
        card.style.gridColumn = `span ${span}`;
        card.style.removeProperty('width');
        card.style.order = index + 1;
    });
    packDashboardMasonry();
    saveDashboardLayout();
}

// "Masonry" via grid-row: cada card ocupa exatamente quantas trilhas de
// DASHBOARD_LAYOUT_ROW_HEIGHT (8px) precisa pra sua altura real. Sem isso, uma
// linha do grid inteira fica com a altura do card MAIS alto dela (ex: o
// gráfico de pizza), e os cards baixos ao lado deixam um vão vazio embaixo —
// eles não esticam pra preencher porque o CSS Grid não sabe que aquele
// espaço "pertence" à próxima linha.
function packDashboardMasonry() {
    const grid = getDashboardGrid();
    if (!grid) return;
    // O row-gap do grid entra UMA VEZ entre cada trilha ocupada — pra um card que
    // atravessa N trilhas de 8px, a altura reservada é N*8 + (N-1)*gap, não N*8.
    // Ignorar o gap nessa conta inflava o span (ex: card de 260px virava ~33
    // trilhas em vez de ~15), reservando um espaço muito maior que o card real
    // e deixando um vão vazio enorme até a próxima linha.
    const rowGap = parseFloat(getComputedStyle(grid).rowGap) || 0;
    const trackHeight = DASHBOARD_LAYOUT_ROW_HEIGHT;
    const spanFor = (height) => Math.max(1, Math.ceil((height + rowGap) / (trackHeight + rowGap)));

    const cards = getDashboardCards().filter(card => card.style.display !== 'none');

    // Cards de KPI que ninguém redimensionou manualmente devem todos ficar com a
    // MESMA altura de trilha — senão uma diferença de 1-2px entre números/textos
    // (ex: "0" vs "2") já é o bastante pra dois cards "iguais" caírem em linhas
    // diferentes, quebrando o alinhamento (desnível visual). Cards de
    // gráfico/lista (.dash-layout-card) continuam com altura própria, já que
    // aqueles são propositalmente diferentes uns dos outros.
    const autoKpiCards = cards.filter(card =>
        card.classList.contains('dash-kpi-card') && !(Number(card.dataset.layoutHeight) > 0)
    );
    let sharedKpiSpan = 1;
    autoKpiCards.forEach(card => {
        sharedKpiSpan = Math.max(sharedKpiSpan, spanFor(card.getBoundingClientRect().height));
    });

    cards.forEach(card => {
        const height = card.getBoundingClientRect().height;
        if (!height) return;
        const span = autoKpiCards.includes(card) ? sharedKpiSpan : spanFor(height);
        card.style.gridRow = `span ${span}`;
    });
}

// layoutData opcional: quando passado, aplica esse arranjo específico (usado
// pelo "Cancelar" pra voltar ao estado de antes de abrir o modo de edição) em
// vez de ler do localStorage.
function applyDashboardLayout(layoutData) {
    const grid = getDashboardGrid();
    if (!grid) return;

    // Se essa é a primeira visita nesse navegador (sem layout individual salvo
    // ainda), cai pro padrão definido pelo admin no servidor — compartilhado por
    // todo mundo — em vez do arranjo de fábrica. O DASH_LAYOUT_DEFAULT_KEY local
    // só entra como último fallback, se o servidor não respondeu.
    const saved = layoutData || readDashboardLayout() || cachedServerDashboardDefault || readDashboardLayout(DASH_LAYOUT_DEFAULT_KEY);
    const cards = getDashboardCards();
    if (saved) {
        const cardMap = new Map(cards.map(card => [getDashboardCardKey(card), card]));
        saved.cards.forEach(item => {
            const card = cardMap.get(item.key);
            if (card) {
                card.dataset.layoutSpan = Math.max(1, Math.min(6, Number(item.span) || 1));
                if (Number(item.height) > 0) card.dataset.layoutHeight = Number(item.height);
                delete card.dataset.layoutWidth;
                card.dataset.hidden = item.hidden ? 'true' : 'false';
                grid.appendChild(card);
            }
        });
    }

    getDashboardCards().forEach((card, index) => {
        const span = Number(card.dataset.layoutSpan) || getDefaultDashboardSpan(index, card);
        card.dataset.layoutSpan = span;
        card.style.gridColumn = `span ${span}`;
        card.style.order = index + 1;
        if (Number(card.dataset.layoutHeight) > 0) {
            card.style.minHeight = '0';
            card.style.height = `${card.dataset.layoutHeight}px`;
        }
        card.style.removeProperty('width');
        // Card oculto some de verdade fora do modo de edição — no modo de edição,
        // renderDashboardCardTools/toggleDashboardCustomizer o mantêm visível (esmaecido)
        // pra dar pra reativar.
        card.classList.toggle('dash-card-hidden', card.dataset.hidden === 'true');
        if (card.dataset.hidden === 'true' && !dashboardCustomizerActive) {
            card.style.display = 'none';
        }
        updateDashboardCardScale(card);
    });
    packDashboardMasonry();
}

function renderDashboardCardTools() {
    getDashboardCards().forEach(card => {
        // Recria do zero em vez de "inserir só se não existir" — depois de um
        // arraste, o card às vezes ficava com os controles presentes no DOM mas
        // sem aparecer (algum resíduo de estilo do position:fixed durante o
        // drag). Remover e recriar elimina qualquer estado inconsistente.
        card.querySelectorAll(':scope > .dash-card-tools, :scope > .dash-card-resize-handle').forEach(el => el.remove());
        const isHidden = card.dataset.hidden === 'true';
        card.insertAdjacentHTML('afterbegin', `
            <div class="dash-card-tools" aria-label="Controles do card">
                <span class="dash-card-drag" title="Arraste para reordenar"><i class="fa-solid fa-grip-vertical"></i></span>
                <button type="button" class="dash-card-visibility" onclick="toggleDashboardCardVisibility(this)" title="${isHidden ? 'Card oculto — clique para mostrar' : 'Ocultar este card'}"><i class="fa-solid ${isHidden ? 'fa-eye-slash' : 'fa-eye'}"></i></button>
            </div>
            <span class="dash-card-resize-handle dash-card-resize-right" data-dash-resize-edge="right" title="Arraste para redimensionar na horizontal"></span>
            <span class="dash-card-resize-handle dash-card-resize-bottom" data-dash-resize-edge="bottom" title="Arraste para redimensionar na vertical"></span>
            <span class="dash-card-resize-handle dash-card-resize-corner" data-dash-resize-edge="corner" title="Arraste para redimensionar"></span>
        `);
    });
}

// Reordenar via Pointer Events (mousedown+move+up), igual ao redimensionamento logo
// abaixo — o drag-and-drop nativo do HTML5 (dragstart/dragover/drop) parava de
// disparar de forma inconsistente entre navegadores/cliques, então trocamos pelo
// mesmo mecanismo que já funciona de forma confiável pro resize.
let dashboardPointerDrag = null;

// Versão simples de propósito: o card NÃO sai do fluxo do grid nem segue o
// cursor "voando" (position:fixed) — ele só ganha destaque visual (sombra/
// opacidade) e troca de lugar quando o cursor passa por cima de outro card.
// A versão "voando" causava um bug onde os controles (arrastar/esconder) do
// próprio card ficavam invisíveis durante e depois do arraste; essa versão
// mais simples não mexe em position/left/top/width/z-index do card, então não
// tem como esse estado ficar "preso".
function startDashboardPointerDrag(event, handle) {
    if (!dashboardCustomizerActive) return;
    const card = handle.closest('.dash-kpi-card, .dash-layout-card');
    if (!card) return;
    event.preventDefault();
    dashboardPointerDrag = { card };
    handle.setPointerCapture?.(event.pointerId);
    card.classList.add('dash-card-dragging');
}

function updateDashboardPointerDrag(event) {
    if (!dashboardPointerDrag) return;
    const { card } = dashboardPointerDrag;
    const under = document.elementFromPoint(event.clientX, event.clientY);
    const targetCard = under ? under.closest('.dash-kpi-card, .dash-layout-card') : null;

    // Marca visualmente o card que vai ser trocado de lugar — mesmo sem o card
    // "voar" atrás do cursor, dá pra ver exatamente onde ele vai cair antes de
    // soltar o botão.
    if (dashboardPointerDrag.dropTarget && dashboardPointerDrag.dropTarget !== targetCard) {
        dashboardPointerDrag.dropTarget.classList.remove('dash-card-drop-target');
    }
    if (targetCard && targetCard !== card) {
        targetCard.classList.add('dash-card-drop-target');
        dashboardPointerDrag.dropTarget = targetCard;
    } else {
        dashboardPointerDrag.dropTarget = null;
    }

    if (!targetCard || targetCard === card) return;
    const cards = getDashboardCards();
    const draggedIndex = cards.indexOf(card);
    const targetIndex = cards.indexOf(targetCard);
    if (draggedIndex === -1 || targetIndex === -1) return;
    if (draggedIndex < targetIndex) targetCard.after(card);
    else targetCard.before(card);
}

function finishDashboardPointerDrag() {
    if (!dashboardPointerDrag) return;
    const { card, dropTarget } = dashboardPointerDrag;
    card.classList.remove('dash-card-dragging');
    if (dropTarget) dropTarget.classList.remove('dash-card-drop-target');
    dashboardPointerDrag = null;
    getDashboardCards().forEach((item, index) => {
        item.style.order = index + 1;
    });
    autoPackDashboardCards();
    // Rede de segurança: garante que o card solto (e todos os outros) continuam
    // com o grip/olho — renderDashboardCardTools só insere o que estiver faltando.
    if (dashboardCustomizerActive) renderDashboardCardTools();
}

function toggleDashboardCardVisibility(button) {
    const card = button.closest('.dash-kpi-card, .dash-layout-card');
    if (!card) return;
    const nowHidden = card.dataset.hidden !== 'true';
    card.dataset.hidden = nowHidden ? 'true' : 'false';
    card.classList.toggle('dash-card-hidden', nowHidden);
    button.innerHTML = `<i class="fa-solid ${nowHidden ? 'fa-eye-slash' : 'fa-eye'}"></i>`;
    button.title = nowHidden ? 'Card oculto — clique para mostrar' : 'Ocultar este card';
    packDashboardMasonry();
    saveDashboardLayout();
}

function startDashboardResize(event, handle) {
    if (!dashboardCustomizerActive) return;
    const card = handle.closest('.dash-kpi-card, .dash-layout-card');
    const grid = getDashboardGrid();
    if (!card || !grid) return;
    event.preventDefault();
    event.stopPropagation();
    dashboardResizing = {
        card,
        grid,
        startX: event.clientX,
        startY: event.clientY,
        startSpan: Number(card.dataset.layoutSpan) || 1,
        startHeight: card.getBoundingClientRect().height,
        edge: handle.dataset.dashResizeEdge
    };
    handle.setPointerCapture?.(event.pointerId);
    document.body.classList.add('dash-is-resizing');
}

function updateDashboardResize(event) {
    if (!dashboardResizing) return;
    const { card, grid, startX, startY, startSpan, startHeight, edge } = dashboardResizing;
    const gridStyle = getComputedStyle(grid);
    const columns = gridStyle.gridTemplateColumns.split(' ').length || 4;
    const gap = parseFloat(gridStyle.columnGap) || 0;
    const gridWidth = grid.getBoundingClientRect().width;
    const columnWidth = (gridWidth - (gap * (columns - 1))) / columns;
    const spanWidth = columnWidth + gap;
    if (edge === 'right' || edge === 'corner') {
        const nextSpan = Math.max(1, Math.min(columns, Math.round(startSpan + (event.clientX - startX) / spanWidth)));
        card.dataset.layoutSpan = nextSpan;
        card.style.gridColumn = `span ${nextSpan}`;
        card.style.removeProperty('width');
        updateDashboardCardScale(card);
    }
    if (edge === 'bottom' || edge === 'corner') {
        const nextHeight = Math.max(DASHBOARD_GRID_ROW_HEIGHT, Math.round((startHeight + event.clientY - startY) / DASHBOARD_GRID_ROW_HEIGHT) * DASHBOARD_GRID_ROW_HEIGHT);
        card.dataset.layoutHeight = nextHeight;
        card.style.minHeight = '0';
        card.style.height = `${nextHeight}px`;
        updateDashboardCardScale(card);
    }
    packDashboardMasonry();
}

function finishDashboardResize() {
    if (!dashboardResizing) return;
    autoPackDashboardCards();
    dashboardResizing = null;
    document.body.classList.remove('dash-is-resizing');
    if (dashboardCustomizerActive) renderDashboardCardTools();
}

// Guarda como o layout estava antes de entrar no modo de edição — "Cancelar"
// (ou ESC) volta pra esse ponto, descartando qualquer arraste/redimensionamento
// feito durante essa sessão de edição.
let dashboardEditSessionSnapshot = null;

function toggleDashboardCustomizer() {
    const grid = getDashboardGrid();
    const button = document.getElementById('dash-customize-btn');
    if (!grid) return;

    dashboardCustomizerActive = !dashboardCustomizerActive;
    if (dashboardCustomizerActive) {
        dashboardEditSessionSnapshot = captureCurrentDashboardLayout();
    }
    renderDashboardCardTools();
    grid.classList.toggle('dash-layout-editing', dashboardCustomizerActive);
    // Cards ocultos ficam visíveis (esmaecidos) enquanto o modo de edição está
    // ativo, pra dar pra reativá-los — e voltam a sumir de verdade ao sair.
    getDashboardCards().forEach(card => {
        if (card.dataset.hidden === 'true') {
            card.style.display = dashboardCustomizerActive ? '' : 'none';
        }
    });
    if (button) {
        button.classList.toggle('active', dashboardCustomizerActive);
        button.innerHTML = dashboardCustomizerActive
            ? '<i class="fa-solid fa-check"></i> Concluir'
            : '<i class="fa-solid fa-sliders"></i> Personalizar';
    }
    if (dashboardCustomizerActive) {
        grid.classList.add('dash-layout-has-tools');
        if (!document.getElementById('dash-layout-cancel-btn')) {
            button.insertAdjacentHTML('afterend', '<button id="dash-layout-cancel-btn" class="btn-secondary" onclick="cancelDashboardCustomizer()" title="Sair sem salvar as mudanças desta sessão (Esc)"><i class="fa-solid fa-xmark"></i> Cancelar</button>');
        }
        const cancelBtn = document.getElementById('dash-layout-cancel-btn');
        if (!document.getElementById('dash-layout-reset-btn')) {
            cancelBtn.insertAdjacentHTML('afterend', '<button id="dash-layout-reset-btn" class="btn-secondary" onclick="resetDashboardLayout()" title="Restaurar layout padrão"><i class="fa-solid fa-rotate-left"></i> Restaurar</button>');
        }
        // Só admin pode definir o padrão global — o backend já recusa (403) quem
        // não for, mas escondendo o botão evita o clique inútil pra quem não pode.
        const isAdminUser = typeof loggedUser !== 'undefined' && loggedUser && (loggedUser.role === 'admin' || loggedUser.username === 'admin');
        if (isAdminUser && !document.getElementById('dash-layout-set-default-btn')) {
            const resetBtn = document.getElementById('dash-layout-reset-btn');
            resetBtn.insertAdjacentHTML('afterend', '<button id="dash-layout-set-default-btn" class="btn-secondary" onclick="setDashboardLayoutAsDefault()" title="Salvar o layout atual como padrão para todos os atendentes"><i class="fa-solid fa-floppy-disk"></i> Definir como Padrão</button>');
        }
    } else {
        grid.classList.remove('dash-layout-has-tools');
        const cancelButton = document.getElementById('dash-layout-cancel-btn');
        if (cancelButton) cancelButton.remove();
        const resetButton = document.getElementById('dash-layout-reset-btn');
        if (resetButton) resetButton.remove();
        const setDefaultButton = document.getElementById('dash-layout-set-default-btn');
        if (setDefaultButton) setDefaultButton.remove();
    }
}

// "Cancelar" (botão ou tecla Esc): descarta qualquer mudança feita durante
// essa sessão de edição, voltando pro layout de quando "Personalizar" foi aberto.
function cancelDashboardCustomizer() {
    if (dashboardEditSessionSnapshot) {
        localStorage.setItem(DASH_LAYOUT_STORAGE_KEY, JSON.stringify(dashboardEditSessionSnapshot));
        applyDashboardLayout(dashboardEditSessionSnapshot);
    }
    if (dashboardCustomizerActive) toggleDashboardCustomizer();
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dashboardCustomizerActive) cancelDashboardCustomizer();
});

function resetDashboardLayout() {
    localStorage.removeItem(DASH_LAYOUT_STORAGE_KEY);
    const grid = getDashboardGrid();
    if (!grid) return;

    // Se o admin definiu um layout padrão pra todo mundo (servidor), "Restaurar"
    // volta pra ele em vez do arranjo original de fábrica.
    const customDefault = cachedServerDashboardDefault || readDashboardLayout(DASH_LAYOUT_DEFAULT_KEY);
    const cards = getDashboardCards();

    if (customDefault) {
        const cardMap = new Map(cards.map(card => [getDashboardCardKey(card), card]));
        customDefault.cards.forEach(item => {
            const card = cardMap.get(item.key);
            if (!card) return;
            grid.appendChild(card);
            card.dataset.layoutSpan = Math.max(1, Math.min(6, Number(item.span) || 1));
            if (Number(item.height) > 0) {
                card.dataset.layoutHeight = Number(item.height);
            } else {
                delete card.dataset.layoutHeight;
            }
            card.dataset.hidden = item.hidden ? 'true' : 'false';
        });
    } else {
        cards.sort((a, b) => Number(a.dataset.originalIndex) - Number(b.dataset.originalIndex));
        cards.forEach((card, index) => {
            grid.appendChild(card);
            card.dataset.layoutSpan = getDefaultDashboardSpan(index, card);
            delete card.dataset.layoutHeight;
            card.dataset.hidden = 'false';
        });
    }

    getDashboardCards().forEach((card, index) => {
        card.style.gridColumn = `span ${card.dataset.layoutSpan}`;
        delete card.dataset.layoutWidth;
        card.classList.toggle('dash-card-hidden', card.dataset.hidden === 'true');
        card.style.removeProperty('min-height');
        if (Number(card.dataset.layoutHeight) > 0) {
            card.style.height = `${card.dataset.layoutHeight}px`;
        } else {
            card.style.removeProperty('height');
        }
        card.style.removeProperty('width');
        card.style.removeProperty('display');
        card.style.order = index + 1;
        updateDashboardCardScale(card);
        const visBtn = card.querySelector('.dash-card-visibility');
        if (visBtn) {
            const isHidden = card.dataset.hidden === 'true';
            visBtn.innerHTML = `<i class="fa-solid ${isHidden ? 'fa-eye-slash' : 'fa-eye'}"></i>`;
            visBtn.title = isHidden ? 'Card oculto — clique para mostrar' : 'Ocultar este card';
        }
    });
    renderDashboard();
}

document.addEventListener('pointerdown', event => {
    const resizeHandle = event.target.closest('[data-dash-resize-edge]');
    if (resizeHandle) { startDashboardResize(event, resizeHandle); return; }
    const dragHandle = event.target.closest('.dash-card-drag');
    if (dragHandle) startDashboardPointerDrag(event, dragHandle);
});

document.addEventListener('pointermove', event => {
    updateDashboardResize(event);
    updateDashboardPointerDrag(event);
});
document.addEventListener('pointerup', () => {
    finishDashboardResize();
    finishDashboardPointerDrag();
});
// Rede de segurança: se o navegador cancelar o gesto no meio do caminho (perda
// de foco da janela, menu de contexto etc.), sem isso o card ficava travado em
// position:fixed pra sempre, com os próprios botões inacessíveis.
document.addEventListener('pointercancel', () => {
    finishDashboardResize();
    finishDashboardPointerDrag();
});

let dashMasonryResizeTimeout = null;
window.addEventListener('resize', () => {
    clearTimeout(dashMasonryResizeTimeout);
    dashMasonryResizeTimeout = setTimeout(packDashboardMasonry, 150);
});

function initializeDashboardCustomizer() {
    const cards = getDashboardCards();
    cards.forEach((card, index) => {
        if (!card.dataset.originalIndex) card.dataset.originalIndex = index;
    });
    applyDashboardLayout();
    renderDashboardCardTools();
}

// === DASHBOARD LOGIC ===
function renderDashboard() {
    if (!Array.isArray(leads)) return;
    const now = new Date();
    const period = dashActivePeriod;

    function isInPeriod(dateStr) {
        if (!dateStr) return false;
        const d = new Date(dateStr);
        if (period === 'custom' && dashCustomRange) {
            const start = new Date(dashCustomRange.start); start.setHours(0,0,0,0);
            const end = new Date(dashCustomRange.end); end.setHours(23,59,59,999);
            return d >= start && d <= end;
        }
        if (period === 'mes') return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        if (period === 'trimestre') {
            const q = Math.floor(now.getMonth() / 3);
            return Math.floor(d.getMonth() / 3) === q && d.getFullYear() === now.getFullYear();
        }
        if (period === 'ano') return d.getFullYear() === now.getFullYear();
        return true;
    }

    let subtitleText;
    if (period === 'custom' && dashCustomRange) {
        const fmt = d => d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
        subtitleText = `Período: ${fmt(dashCustomRange.start)} — ${fmt(dashCustomRange.end)}`;
    } else {
        const subtitles = { mes: 'Dados do mês atual', trimestre: 'Dados do trimestre atual', ano: 'Dados do ano atual', tudo: 'Todos os dados históricos' };
        subtitleText = subtitles[period] || '';
    }
    const subtitleEl = document.getElementById('dash-subtitle');
    if (subtitleEl) subtitleEl.innerText = subtitleText;

    let receitaPrevista = 0, receitaRealizada = 0, agendamentosComValor = 0;
    let leadsAtivos = 0, agendadosTotal = 0, ganhosTotal = 0, perdidosTotal = 0;
    let leadsContatados = 0; // Leads que entraram no período selecionado
    let semResponsavel = 0, aguardandoResposta = 0;
    let responseMinutesTotal = 0, responseCount = 0;
    let perdasTotal = 0;
    const rankingMap = {};
    const origemMap = {};
    // LTV: agrupa por paciente (telefone canônico dedup entre cards diferentes).
    // Sempre histórico — "valor no tempo de vida" não faz sentido por período.
    const ltvMap = {};

    leads.forEach(lead => {
        let val = parseFloat(lead.valor_recebido) || 0;
        if (!val) {
            val = parseOrcamentoArray(lead.orcamento).reduce((sum, item) => sum + (parseFloat(item.valor) || 0), 0);
        }
        const inPeriod = isInPeriod(lead.created_at);
        const leadPhone = String(lead.telefone || '').replace(/\D/g, '');
        const responseMetric = Object.entries(dashboardResponseMetrics).find(([phone]) => String(phone).replace(/\D/g, '') === leadPhone)?.[1];
        // Receita é filtrada pela data em que o valor foi definido (orçado/agendado/ganho),
        // não pela data de criação do lead — um lead antigo cujo orçamento só foi fechado
        // agora precisa contar no período atual, não sumir por ter entrado no CRM há meses.
        const revenueInPeriod = isInPeriod(lead.data_valor || lead.created_at);

        const orig = lead.origem || 'Não informado';
        origemMap[orig] = (origemMap[orig] || 0) + 1;

        // Conta leads que entraram no período selecionado
        if (inPeriod) leadsContatados++;
        if (inPeriod && !lead.owner_id) semResponsavel++;
        if (inPeriod && responseMetric) {
            if (responseMetric.lastDirection === 'in' && !responseMetric.firstResponse) aguardandoResposta++;
            if (responseMetric.firstInbound && responseMetric.firstResponse) {
                const firstInbound = new Date(responseMetric.firstInbound).getTime();
                const firstResponse = new Date(responseMetric.firstResponse).getTime();
                if (firstResponse >= firstInbound) {
                    responseMinutesTotal += (firstResponse - firstInbound) / 60000;
                    responseCount++;
                }
            }
        }

        if (lead.column === 'col-ganho') {
            if (inPeriod) ganhosTotal++;
            if (revenueInPeriod) { receitaRealizada += val; if (val > 0) agendamentosComValor++; }
            // LTV histórico: acumula receita realizada por paciente.
            if (val > 0) {
                const pkey = (typeof canonicalPhoneBR === 'function' && canonicalPhoneBR(lead.telefone)) || ('lead:' + lead.id);
                if (!ltvMap[pkey]) ltvMap[pkey] = { revenue: 0, deals: 0 };
                ltvMap[pkey].revenue += val;
                ltvMap[pkey].deals += 1;
            }
        } else if (lead.column === 'col-agendado') {
            if (inPeriod) agendadosTotal++;
            if (revenueInPeriod) { receitaPrevista += val; if (val > 0) agendamentosComValor++; }
        } else if (lead.column === 'col-perdido') {
            if (inPeriod) perdidosTotal++;
            if (revenueInPeriod) perdasTotal += val;
        } else {
            if (inPeriod) leadsAtivos++;
        }

        if (inPeriod) {
            const owner = lead.owner_id || 'Sem Dono';
            if (!rankingMap[owner]) rankingMap[owner] = { name: owner, leads: 0, agendamentos: 0, receita: 0 };
            rankingMap[owner].leads++;
            if (lead.column === 'col-agendado' || lead.column === 'col-ganho') {
                rankingMap[owner].agendamentos++;
                if (revenueInPeriod) rankingMap[owner].receita += val;
            }
        }
    });

    const ticketMedio = agendamentosComValor > 0 ? ((receitaPrevista + receitaRealizada) / agendamentosComValor) : 0;

    // LTV (histórico, não filtrado por período)
    const ltvPatients = Object.keys(ltvMap).length;
    const ltvValues = Object.values(ltvMap);
    const ltvTotalRevenue = ltvValues.reduce((s, p) => s + p.revenue, 0);
    const ltvDeals = ltvValues.reduce((s, p) => s + p.deals, 0);
    const ltvMedio = ltvPatients > 0 ? ltvTotalRevenue / ltvPatients : 0;
    const comprasPorPaciente = ltvPatients > 0 ? ltvDeals / ltvPatients : 0;
    const leadsNoPeriodo = leads.filter(lead => isInPeriod(lead.created_at)).length;
    const taxaConversao = leadsNoPeriodo > 0 ? Math.round(((agendadosTotal + ganhosTotal) / leadsNoPeriodo) * 100) : 0;
    const tempoMedioResposta = responseCount > 0 ? responseMinutesTotal / responseCount : NaN;

    const el = id => document.getElementById(id);
    if (el('dash-receita-prevista')) el('dash-receita-prevista').innerText = 'R$ ' + receitaPrevista.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    if (el('dash-receita-realizada')) el('dash-receita-realizada').innerText = 'R$ ' + receitaRealizada.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    if (el('dash-ticket-medio')) el('dash-ticket-medio').innerText = 'R$ ' + ticketMedio.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    if (el('dash-ltv-medio')) el('dash-ltv-medio').innerText = 'R$ ' + ltvMedio.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    if (el('dash-ltv-pacientes')) el('dash-ltv-pacientes').innerText = ltvPatients + (ltvPatients === 1 ? ' paciente' : ' pacientes');
    if (el('dash-compras-paciente')) el('dash-compras-paciente').innerText = comprasPorPaciente.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '×';
    if (el('dash-leads-ativos')) el('dash-leads-ativos').innerText = leadsAtivos;
    if (el('dash-taxa-resposta')) el('dash-taxa-resposta').innerText = taxaConversao + '%';
    if (el('dash-agendamentos-total')) el('dash-agendamentos-total').innerText = agendadosTotal + ganhosTotal;
    if (el('dash-leads-hoje')) el('dash-leads-hoje').innerText = leadsContatados;
    if (el('dash-perdas-total')) el('dash-perdas-total').innerText = 'R$ ' + perdasTotal.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    if (el('dash-sem-responsavel')) el('dash-sem-responsavel').innerText = semResponsavel;
    if (el('dash-aguardando-resposta')) el('dash-aguardando-resposta').innerText = aguardandoResposta;
    if (el('dash-tempo-resposta')) el('dash-tempo-resposta').innerText = formatResponseTime(tempoMedioResposta);

    // Ranking - premium cards
    const rankingArray = Object.values(rankingMap).sort((a, b) => b.receita - a.receita);
    const rankingBody = el('dash-ranking-body');
    if (rankingBody) {
        const medals = ['🥇', '🥈', '🥉'];
        const maxLeads = Math.max(...rankingArray.map(r => r.leads), 1);
        rankingBody.innerHTML = rankingArray.length === 0
            ? '<div style="color: var(--text-muted); font-size: 0.85rem; text-align: center; padding: 1rem;">Nenhum atendente ainda.</div>'
            : rankingArray.map((r, idx) => {
                const conv = r.leads > 0 ? Math.round((r.agendamentos / r.leads) * 100) : 0;
                const barPct = Math.round((r.leads / maxLeads) * 100);
                const medal = medals[idx] || (idx + 1) + 'º';
                
                const displayName = typeof resolveDisplayName === 'function' ? resolveDisplayName(r.name) : r.name;
                const avatarUrl = (typeof avatarMap !== 'undefined' && avatarMap[r.name]) ? avatarMap[r.name] : null;
                
                let avatarHtml = '';
                if (typeof renderAvatarHTML === 'function') {
                    avatarHtml = renderAvatarHTML(displayName, avatarUrl, null, 32);
                } else {
                    const charArray = Array.from(displayName.trim());
                    let initial1 = charArray[0] || '';
                    let initial2 = charArray[1] || '';
                    if (initial1.match(/[\uD800-\uDFFF]/)) { initial1 = 'U'; initial2 = 'S'; }
                    const initials = (initial1 + initial2).toUpperCase();
                    avatarHtml = `<div style="width: 32px; height: 32px; border-radius: 50%; background: var(--bg-main); color: var(--text-main); display: flex; align-items: center; justify-content: center; font-size: 0.8rem; font-weight: 700; flex-shrink: 0; border: 1px solid var(--border-color);">${initials}</div>`;
                }

                return `<div style="display: flex; flex-direction: column; gap: 0.5rem; padding: 0.8rem; background: var(--header-btn-bg); border-radius: 12px; border: 1px solid var(--header-btn-border);">
                    <div style="display: flex; align-items: center; gap: 0.55rem; min-width: 0;">
                        <span style="font-size: 1.05rem; width: 1.4rem; text-align: center; flex-shrink: 0;">${medal}</span>
                        <span style="flex-shrink: 0; display: inline-flex;">${avatarHtml}</span>
                        <span style="font-weight: 700; color: var(--text-main); font-size: 0.9rem; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${displayName}">${displayName}</span>
                    </div>

                    <div style="display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem;">
                        <span style="font-size: 0.72rem; color: var(--text-muted);">${r.leads} leads &middot; ${conv}% conv.</span>
                        <span style="font-weight: 700; color: #10b981; font-size: 0.85rem; white-space: nowrap;">R$ ${r.receita.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
                    </div>

                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                        <div style="flex: 1; height: 5px; background: var(--border-color); border-radius: 99px; overflow: hidden;">
                            <div style="height: 100%; width: ${barPct}%; background: var(--accent-primary); border-radius: 99px;"></div>
                        </div>
                        <span style="font-size: 0.7rem; color: var(--text-muted); white-space: nowrap; flex-shrink: 0;">${r.agendamentos} agend.</span>
                    </div>
                </div>`;
            }).join('');
    }

    // Meta de receita acompanha o faturamento realizado (Ganho), não a previsão de
    // agendados — meta é sobre dinheiro que já entrou, não sobre o que ainda pode cair.
    renderDashboardGoal(receitaRealizada);
    renderCharts(origemMap, isInPeriod);
}

// === META DE RECEITA (DASHBOARD) ===
let cachedDashGoal = null;

async function loadDashboardGoal() {
    try {
        const res = await fetch('/api/settings/dashboard-goal');
        const json = await res.json();
        cachedDashGoal = json.valor || null;
    } catch (e) {
        cachedDashGoal = null;
    }
}

function renderDashboardGoal(receitaTotal) {
    const card = document.getElementById('dash-goal-card');
    if (!card) return;
    card.style.display = 'block';

    const isAdmin = typeof loggedUser !== 'undefined' && loggedUser && (loggedUser.role === 'admin' || loggedUser.username === 'admin');
    const editBtn = document.getElementById('dash-goal-edit-btn');
    if (editBtn) editBtn.style.display = isAdmin ? 'inline-flex' : 'none';

    const subtitleEl = document.getElementById('dash-goal-subtitle');
    const emptyEl = document.getElementById('dash-goal-empty');
    const progressWrap = document.getElementById('dash-goal-progress-wrap');

    if (!cachedDashGoal || cachedDashGoal <= 0) {
        if (subtitleEl) subtitleEl.textContent = 'Acompanhe a receita do período em relação a uma meta.';
        if (emptyEl) emptyEl.style.display = 'block';
        if (progressWrap) progressWrap.style.display = 'none';
        return;
    }

    if (subtitleEl) subtitleEl.textContent = 'Receita do período selecionado em relação à meta definida.';
    if (emptyEl) emptyEl.style.display = 'none';
    if (progressWrap) progressWrap.style.display = 'block';

    const pct = Math.min(100, Math.max(0, (receitaTotal / cachedDashGoal) * 100));
    const bar = document.getElementById('dash-goal-bar');
    if (bar) {
        bar.style.transform = 'scaleX(' + (pct / 100).toFixed(4) + ')';
        // Gradiente azul -> verde conforme a receita se aproxima da meta
        const start = [59, 130, 246]; // azul
        const end = [16, 185, 129]; // verde
        const t = pct / 100;
        const rgb = start.map((c, i) => Math.round(c + (end[i] - c) * t));
        bar.style.background = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    }

    const currentEl = document.getElementById('dash-goal-current');
    const pctEl = document.getElementById('dash-goal-pct');
    const targetEl = document.getElementById('dash-goal-target');
    if (currentEl) currentEl.textContent = 'R$ ' + receitaTotal.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    if (pctEl) pctEl.textContent = Math.round(pct) + '%';
    if (targetEl) targetEl.textContent = 'Meta: R$ ' + cachedDashGoal.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
}

function openDashGoalEditor() {
    const editor = document.getElementById('dash-goal-editor');
    const input = document.getElementById('dash-goal-input');
    if (input) input.value = cachedDashGoal || '';
    if (editor) editor.style.display = 'flex';
    // O card "Meta de Receita" faz parte do masonry do dashboard (grid-row: span N,
    // calculado pela altura real do card). Abrir o editor aumenta a altura, mas o
    // span já calculado não muda sozinho — sem repack, o conteúdo extra transborda
    // pra fora da célula e fica coberto pelo próximo card (que pinta por cima por
    // vir depois no DOM). dash-card-elevated garante que fique por cima enquanto
    // o repack (que precisa do próximo frame pra ler a altura já expandida) roda.
    const card = editor ? editor.closest('.dash-kpi-card, .dash-layout-card') : null;
    if (card) card.classList.add('dash-card-elevated');
    // Chamada síncrona, sem requestAnimationFrame: packDashboardMasonry() lê
    // getBoundingClientRect(), que força um reflow imediato — com RAF, o card ficava
    // um frame inteiro com a caixa (fundo) na altura antiga enquanto o conteúdo do
    // editor já tinha transbordado pra fora dela, sem nenhum fundo atrás.
    if (typeof packDashboardMasonry === 'function') packDashboardMasonry();
}

function cancelDashGoalEdit() {
    const editor = document.getElementById('dash-goal-editor');
    if (editor) editor.style.display = 'none';
    const card = editor ? editor.closest('.dash-kpi-card, .dash-layout-card') : null;
    if (card) card.classList.remove('dash-card-elevated');
    if (typeof packDashboardMasonry === 'function') packDashboardMasonry();
}

async function saveDashGoal() {
    const input = document.getElementById('dash-goal-input');
    const valor = parseFloat(input ? input.value : NaN);
    if (isNaN(valor) || valor < 0) {
        alert('Digite um valor de meta válido.');
        return;
    }
    try {
        const res = await fetch('/api/settings/dashboard-goal', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ valor })
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Erro ao salvar meta');
        cachedDashGoal = valor;
        cancelDashGoalEdit();
        renderDashboard();
        if (typeof showToast === 'function') showToast('Meta atualizada!', 'success');
    } catch (e) {
        alert(e.message);
    }
}

// === UNIDADES (multi-clínica) ===
let cachedUnidades = [];

async function loadUnidades() {
    const listEl = document.getElementById('unidades-list');
    if (listEl) listEl.innerHTML = `<div style="text-align:center; padding: 1rem 0; color: var(--text-muted); font-size: 0.85rem;"><span class="amicro-loader"><span></span><span></span><span></span></span> Carregando...</div>`;

    try {
        const res = await fetch('/api/unidades');
        const json = await res.json();
        cachedUnidades = json.items || [];
        renderUnidadesList();
        renderUnidadeSelector();
    } catch (e) {
        if (listEl) listEl.innerHTML = `<div style="text-align:center; padding: 1rem 0; color: var(--accent-danger); font-size: 0.85rem;">Falha ao carregar unidades.</div>`;
    }
}

function renderUnidadesList() {
    const listEl = document.getElementById('unidades-list');
    if (!listEl) return;

    const isAdmin = typeof loggedUser !== 'undefined' && loggedUser && (loggedUser.role === 'admin' || loggedUser.username === 'admin');

    if (cachedUnidades.length === 0) {
        listEl.innerHTML = `<div style="text-align:center; padding: 1rem 0; color: var(--text-muted); font-size: 0.85rem;">Nenhuma unidade cadastrada.</div>`;
        return;
    }

    listEl.innerHTML = cachedUnidades.map(u => `
        <div style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: 8px; padding: 0.7rem 0.9rem; display: flex; align-items: center; justify-content: space-between; gap: 0.6rem;">
            <div style="display: flex; align-items: center; gap: 0.6rem;">
                <i class="fa-solid fa-hospital" style="color: ${u.ativo ? 'var(--accent-success)' : 'var(--text-muted)'};"></i>
                <strong style="color: var(--text-main); font-size: 0.88rem;">${escapeHtml(u.nome)}</strong>
                ${!u.ativo ? '<span style="font-size: 0.7rem; color: var(--text-muted); background: rgba(255,255,255,0.06); padding: 0.1rem 0.5rem; border-radius: 20px;">Inativa</span>' : ''}
            </div>
            ${isAdmin ? `
            <div style="display: flex; gap: 0.4rem;">
                <button type="button" onclick="promptUnidadeToken('${u.id}', '${u.nome.replace(/'/g, "\\'")}')" title="Definir/trocar token do Amigo" style="background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 0.3rem;"><i class="fa-solid fa-key"></i></button>
                <button type="button" onclick="toggleUnidadeAtivo('${u.id}', ${u.ativo ? 'false' : 'true'})" title="${u.ativo ? 'Desativar' : 'Reativar'}" style="background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 0.3rem;"><i class="fa-solid fa-${u.ativo ? 'ban' : 'rotate-left'}"></i></button>
                ${cachedUnidades.length > 1 ? `<button type="button" onclick="deleteUnidadeItem('${u.id}')" title="Excluir" style="background: none; border: none; color: var(--accent-danger); cursor: pointer; padding: 0.3rem;"><i class="fa-solid fa-trash"></i></button>` : ''}
            </div>` : ''}
        </div>
    `).join('');
}

async function createUnidade() {
    const nomeInput = document.getElementById('unidade-nome-input');
    const tokenInput = document.getElementById('unidade-token-input');
    const nome = nomeInput ? nomeInput.value.trim() : '';
    const amigo_api_token = tokenInput ? tokenInput.value.trim() : '';

    if (!nome) {
        alert('Digite o nome da unidade.');
        return;
    }

    try {
        const res = await fetch('/api/unidades', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome, amigo_api_token })
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Erro ao criar unidade');

        nomeInput.value = '';
        tokenInput.value = '';
        if (typeof showToast === 'function') showToast('Unidade criada!', 'success');
        await loadUnidades();
    } catch (e) {
        alert(e.message);
    }
}

async function promptUnidadeToken(id, nome) {
    const token = prompt(`Cole o token da API do Amigo pra "${nome}":`);
    if (token === null) return; // cancelou
    try {
        const res = await fetch(`/api/unidades/${encodeURIComponent(id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amigo_api_token: token })
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Erro ao salvar token');
        if (typeof showToast === 'function') showToast('Token atualizado.', 'success');
        await loadUnidades();
    } catch (e) {
        alert(e.message);
    }
}

async function toggleUnidadeAtivo(id, novoAtivo) {
    try {
        const res = await fetch(`/api/unidades/${encodeURIComponent(id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ativo: novoAtivo })
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Erro ao atualizar unidade');
        await loadUnidades();
    } catch (e) {
        alert(e.message);
    }
}

async function deleteUnidadeItem(id) {
    if (!await customConfirm('Excluir esta unidade? A agenda ligada a ela deixa de aparecer no seletor.', 'Excluir Unidade')) return;
    try {
        const res = await fetch(`/api/unidades/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Erro ao excluir unidade');
        if (typeof showToast === 'function') showToast('Unidade excluída.', 'success');
        await loadUnidades();
    } catch (e) {
        alert(e.message);
    }
}

// Seletor de unidade na Agenda — só aparece quando existe mais de uma unidade
// cadastrada, pra não poluir a tela hoje (com só a Taguatinga configurada).
function getSelectedUnidadeId() {
    return localStorage.getItem('crm_unidade_ativa') || (cachedUnidades[0] ? cachedUnidades[0].id : '');
}

function setSelectedUnidadeId(id) {
    localStorage.setItem('crm_unidade_ativa', id);
}

function renderUnidadeSelector() {
    const wrap = document.getElementById('agenda-unidade-selector-wrap');
    const select = document.getElementById('agenda-unidade-select');
    if (!wrap || !select) return;

    if (cachedUnidades.length <= 1) {
        wrap.style.display = 'none';
        return;
    }

    wrap.style.display = 'flex';
    const current = getSelectedUnidadeId();
    select.innerHTML = cachedUnidades.filter(u => u.ativo).map(u => `<option value="${u.id}" ${u.id === current ? 'selected' : ''}>${escapeHtml(u.nome)}</option>`).join('');
}

function onAgendaUnidadeChange() {
    const select = document.getElementById('agenda-unidade-select');
    if (!select) return;
    setSelectedUnidadeId(select.value);
    if (typeof fetchApiOptions === 'function') fetchApiOptions();
    if (typeof renderAgendaGrid === 'function') renderAgendaGrid();
}

let leadsChartInst = null;
let funnelChartInst = null;
let origemChartInst = null;

function renderCharts(origemMap = {}, isInPeriod = () => true) {
    if (!window.Chart) return;

    const isDark = document.body.getAttribute('data-theme') !== 'light';
    const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
    const textColor = isDark ? '#a1a1aa' : '#71717a';

    // Leads Line Chart — respeita o período selecionado
    const days = [], counts = [];
    for (let i = 13; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        days.push(d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }));
        counts.push(0);
    }
    leads.forEach(l => {
        if (l.created_at && isInPeriod(l.created_at)) {
            const d = parseSqlDate ? parseSqlDate(l.created_at) : new Date(l.created_at);
            const str = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
            const idx = days.indexOf(str);
            if (idx !== -1) counts[idx]++;
        }
    });

    const ctxLeads = document.getElementById('leadsChart');
    if (ctxLeads) {
        if (leadsChartInst) leadsChartInst.destroy();
        const leadsGrad = ctxLeads.getContext('2d').createLinearGradient(0, 0, 0, ctxLeads.offsetHeight || 220);
        leadsGrad.addColorStop(0,   'rgba(56, 189, 248, 0.38)');
        leadsGrad.addColorStop(0.65,'rgba(56, 189, 248, 0.08)');
        leadsGrad.addColorStop(1,   'rgba(56, 189, 248, 0)');
        leadsChartInst = new Chart(ctxLeads, {
            type: 'line',
            data: {
                labels: days,
                datasets: [{
                    label: 'Novos Leads',
                    data: counts,
                    borderColor: '#38bdf8',
                    tension: 0.4,
                    fill: true,
                    backgroundColor: leadsGrad,
                    pointBackgroundColor: '#38bdf8',
                    pointBorderColor: '#ffffff',
                    pointBorderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 6,
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                plugins: { 
                    legend: { display: false }, 
                    tooltip: { 
                        backgroundColor: 'rgba(9, 9, 11, 0.95)',
                        titleColor: '#a1a1aa',
                        bodyColor: '#fafafa',
                        borderColor: 'rgba(39, 39, 42, 1)',
                        borderWidth: 1,
                        padding: 12,
                        cornerRadius: 8,
                        displayColors: true,
                        boxPadding: 6,
                        usePointStyle: true,
                        titleFont: { size: 12, weight: 'normal', family: 'Inter, sans-serif' },
                        bodyFont: { size: 14, weight: 'bold', family: 'Inter, sans-serif' }
                    } 
                },
                scales: {
                    x: { 
                        grid: { display: false, drawBorder: false }, 
                        ticks: { 
                            color: 'rgba(255, 255, 255, 0.5)', 
                            font: { size: 11 },
                            maxTicksLimit: 5, // Sparse x-axis labels
                            maxRotation: 0
                        },
                        border: { display: false }
                    },
                    y: { 
                        grid: { 
                            color: 'rgba(255, 255, 255, 0.05)', // Super subtle grid
                            drawBorder: false,
                            borderDash: [5, 5] // Dashed lines
                        }, 
                        ticks: { display: false }, // Hide Y-axis numbers completely
                        beginAtZero: true,
                        border: { display: false }
                    }
                }
            }
        });
    }

    // Funnel Bar Chart — filtra pelo período selecionado e usa lead.column (normalizado)
    let colEnt = 0, colCont = 0, colOrc = 0, colAgen = 0, colGanho = 0, colPerd = 0;
    leads.forEach(l => {
        if (!isInPeriod(l.created_at)) return;
        if (l.column === 'col-entrada') colEnt++;
        else if (l.column === 'col-contatado') colCont++;
        else if (l.column === 'col-orcado') colOrc++;
        else if (l.column === 'col-agendado') colAgen++;
        else if (l.column === 'col-ganho') colGanho++;
        else if (l.column === 'col-perdido') colPerd++;
    });

    const funnelContainer = document.getElementById('funnelChart');
    if (funnelContainer) {
        if (funnelChartInst) { funnelChartInst.destroy(); funnelChartInst = null; }
        
        funnelContainer.innerHTML = '';
        funnelContainer.style.position = 'relative';
        funnelContainer.style.display = 'flex';
        funnelContainer.style.flexDirection = 'row';
        
        const data = [
            { label: 'Entrada', value: colEnt },
            { label: 'Contatado', value: colCont },
            { label: 'Orçado', value: colOrc },
            { label: 'Agendado', value: colAgen },
            { label: 'Ganho', value: colGanho }
        ];

        const n = data.length;
        const formatValue = (val) => val >= 1000 ? (val/1000).toFixed(1).replace('.0','') + 'k' : val.toString();
        const maxVal = Math.max(...data.map(d => d.value), 1);

        let svgHtml = `<svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" style="position: absolute; top: 0; left: 0; z-index: 1;">
            <defs>
                <linearGradient id="funnelGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%"   stop-color="#7dd3fc"/>
                    <stop offset="100%" stop-color="#0284c7"/>
                </linearGradient>
            </defs>`;
        
        const w = 100 / n;
        
        // Define multipliers and opacities for the 3 layers
        const layers = [
            { mult: 1.0, op: 0.15 },
            { mult: 0.65, op: 0.35 },
            { mult: 0.3, op: 0.8 }
        ];
        
        // Calculate heights at boundaries (x = 0, w, 2w... 5w)
        const H = [];
        for (let i = 0; i < n; i++) {
            // max height is 60 (to leave room for labels at top and bottom)
            H.push( Math.max((data[i].value / maxVal) * 60, 4) );
        }
        // Flat segment at the end
        H.push(H[n-1]);
        
        layers.forEach((layer, lIdx) => {
            let d = `M 0 ${50 - (H[0] * layer.mult)/2} `;
            
            // Top curve
            for(let i=0; i<n; i++) {
                const x_start = i * w;
                const x_end = (i+1) * w;
                const y_start = 50 - (H[i] * layer.mult)/2;
                const y_end = 50 - (H[i+1] * layer.mult)/2;
                d += `C ${(x_start + x_end)/2} ${y_start}, ${(x_start + x_end)/2} ${y_end}, ${x_end} ${y_end} `;
            }
            
            // Line down at the right edge
            d += `L 100 ${50 + (H[n] * layer.mult)/2} `;
            
            // Bottom curve (backwards)
            for(let i=n-1; i>=0; i--) {
                const x_start = i * w;
                const x_end = (i+1) * w;
                const y_start = 50 + (H[i] * layer.mult)/2;
                const y_end = 50 + (H[i+1] * layer.mult)/2;
                d += `C ${(x_start + x_end)/2} ${y_end}, ${(x_start + x_end)/2} ${y_start}, ${x_start} ${y_start} `;
            }
            
            d += `Z`;
            
            svgHtml += `<path d="${d}" fill="url(#funnelGrad)" opacity="${layer.op}" style="animation: funnel-fade-in 0.6s ease forwards; animation-delay: ${lIdx * 0.15}s; opacity: 0;" />`;
        });
        
        // Dividers
        for(let i=1; i<n; i++) {
            const x = i * w;
            svgHtml += `<line x1="${x}" y1="0" x2="${x}" y2="100" stroke="var(--dash-funnel-sep)" stroke-width="0.5" />`;
        }
        
        svgHtml += `</svg>`;
        
        let labelsHtml = `<div style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 2; pointer-events: none;">`;
        
        for (let i = 0; i < n; i++) {
            const x_c = (i + 0.5) * w;
            const perc = Math.round((data[i].value / maxVal) * 100) + '%';
            const dispVal = formatValue(data[i].value);
            const delay = i * 0.1;
            
            labelsHtml += `
                <!-- Top Value Label -->
                <div style="position: absolute; top: 5%; left: ${x_c}%; transform: translateX(-50%); font-weight: 700; font-size: 0.95rem; color: var(--text-main); animation: funnel-fade-in-up 0.4s ease forwards; animation-delay: ${delay}s; opacity: 0;">
                    ${dispVal}
                </div>
                
                <!-- Center Badge (Pill) -->
                <div style="position: absolute; top: 50%; left: ${x_c}%; transform: translate(-50%, -50%); background: #ffffff; color: #000000; font-size: 0.75rem; font-weight: 800; padding: 0.2rem 0.65rem; border-radius: 999px; box-shadow: none; animation: funnel-zoom-in 0.4s ease forwards; animation-delay: ${delay + 0.2}s; opacity: 0;">
                    ${perc}
                </div>
                
                <!-- Bottom Stage Label -->
                <div style="position: absolute; bottom: 5%; left: ${x_c}%; transform: translateX(-50%); font-size: 0.8rem; font-weight: 500; color: var(--text-muted); animation: funnel-fade-in-up 0.4s ease forwards; animation-delay: ${delay + 0.1}s; opacity: 0; white-space: nowrap;">
                    ${data[i].label}
                </div>
            `;
        }
        
        labelsHtml += `</div>`;
        funnelContainer.innerHTML = svgHtml + labelsHtml;
    }

    // Origem Doughnut Chart
    const origemLabels = Object.keys(origemMap);
    const origemValues = Object.values(origemMap);
    const origemColors = ['#60a5fa', '#f59e0b', '#10b981', '#2dd4bf', '#38bdf8', '#fb923c', '#f472b6'];

    const ctxOrigem = document.getElementById('origemChart');
    if (ctxOrigem) {
        if (origemChartInst) origemChartInst.destroy();
        if (origemLabels.length === 0) {
            ctxOrigem.style.display = 'none';
        } else {
            ctxOrigem.style.display = '';

            origemChartInst = new Chart(ctxOrigem, {
                type: 'doughnut',
                data: {
                    labels: origemLabels,
                    datasets: [{
                        data: origemValues,
                        backgroundColor: origemColors.slice(0, origemLabels.length),
                        borderWidth: 0,
                        borderColor: 'transparent',
                        borderRadius: 8,
                        spacing: 2,
                        hoverOffset: 6
                    }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    cutout: '72%',
                    plugins: { legend: { display: false }, tooltip: { mode: 'index' } }
                }
            });
        }
    }

    // Origem Legend
    const legendEl = document.getElementById('dash-origem-legend');
    if (legendEl) {
        const total = origemValues.reduce((a, b) => a + b, 0);
        legendEl.innerHTML = origemLabels.map((l, i) => {
            const pct = total > 0 ? Math.round((origemValues[i] / total) * 100) : 0;
            return `<div style="display:flex;align-items:center;justify-content:space-between;font-size:0.78rem;">
                <div style="display:flex;align-items:center;gap:0.4rem;">
                    <div style="width:10px;height:10px;border-radius:3px;background:${origemColors[i] || '#888'};flex-shrink:0;"></div>
                    <span style="color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px;">${l}</span>
                </div>
                <span style="font-weight:600;color:var(--text-main);">${pct}%</span>
            </div>`;
        }).join('');
    }

    // Reempacota depois que os gráficos (Chart.js) terminam de desenhar — o
    // tamanho real do canvas só é conhecido depois desse ponto.
    if (typeof packDashboardMasonry === 'function') {
        packDashboardMasonry();
        setTimeout(packDashboardMasonry, 50);
    }
}

// === CAMPANHAS DE DISPARO ===
// Aplica, em ordem, os 3 filtros de proteção da campanha: opt-out do lead,
// exigência de conversa real por WhatsApp (opt-in confirmado), e — se pedido —
// não repetir o mesmo template pra quem já recebeu ele antes.
async function getEligibleCampaignLeads(targetCol, templateName, skipRepeated) {
    let candidateLeads;
    if (targetCol === 'all') {
        candidateLeads = leads.filter(l => l.telefone && l.telefone.trim() !== '');
    } else if (targetCol.startsWith('audience:')) {
        const audienceId = targetCol.slice('audience:'.length);
        const audience = cachedAudiences.find(a => a.id === audienceId);
        candidateLeads = audience
            ? filterLeadsByAudience(audience).filter(l => l.telefone && l.telefone.trim() !== '')
            : [];
    } else {
        candidateLeads = leads.filter(l => l.column === targetCol && l.telefone && l.telefone.trim() !== '');
    }

    const optedOutCount = candidateLeads.filter(l => Number(l.campaign_opt_out) === 1).length;
    let result = candidateLeads.filter(l => Number(l.campaign_opt_out) !== 1);

    const chatsRes = await fetch('/api/whatsapp/chats');
    const chatsJson = await chatsRes.json();
    const contactedPhones = new Set((chatsJson.data || []).map(c => canonicalPhoneBR(c.phone)));
    const beforeHistory = result.length;
    result = result.filter(l => contactedPhones.has(canonicalPhoneBR(l.telefone)));
    const noHistoryCount = beforeHistory - result.length;

    let repeatedCount = 0;
    if (skipRepeated && templateName) {
        const sendsRes = await fetch(`/api/whatsapp/template-sends/${encodeURIComponent(templateName)}`);
        const sendsJson = await sendsRes.json();
        const alreadySent = new Set((sendsJson.phones || []).map(p => canonicalPhoneBR(p)));
        const beforeRepeat = result.length;
        result = result.filter(l => !alreadySent.has(canonicalPhoneBR(l.telefone)));
        repeatedCount = beforeRepeat - result.length;
    }

    return { eligible: result, optedOutCount, noHistoryCount, repeatedCount };
}

async function updateCampaignLeadCount() {
    const slider = document.getElementById('campaign-lead-limit');
    const display = document.getElementById('campaign-lead-limit-display');
    const hint = document.getElementById('campaign-lead-limit-hint');
    const targetSelect = document.getElementById('campaign-target');
    const templateSelect = document.getElementById('campaign-template-select');
    const skipRepeatedEl = document.getElementById('campaign-skip-repeated');
    if (!slider || !targetSelect) return;

    const targetCol = targetSelect.value;
    const templateName = templateSelect && templateSelect.value ? templateSelect.value.split('|')[0] : '';
    const skipRepeated = skipRepeatedEl ? skipRepeatedEl.checked : true;

    let eligibleCount = 0;
    if (hint) hint.textContent = 'Calculando leads elegíveis...';

    try {
        const { eligible } = await getEligibleCampaignLeads(targetCol, templateName, skipRepeated);
        eligibleCount = eligible.length;
    } catch (e) {
        console.error('Erro ao calcular leads elegíveis para campanha:', e);
    }

    // Trava em 250 — limite de conversas iniciadas por dia da Meta pra contas
    // no Tier 1 (novas/não verificadas). Passar disso arrisca mensagens
    // rejeitadas ou queda na nota de qualidade do número.
    const CAMPAIGN_DISPATCH_LIMIT = 250;
    const cappedEligible = Math.min(eligibleCount, CAMPAIGN_DISPATCH_LIMIT);
    const max = Math.max(cappedEligible, 1);
    slider.max = String(max);
    slider.value = String(max);
    slider.disabled = eligibleCount === 0;
    if (display) display.textContent = String(cappedEligible);
    if (hint) {
        if (eligibleCount === 0) {
            hint.textContent = 'Nenhum lead elegível nesse público (sem opt-in confirmado, todos já receberam esse template, ou pediram pra não receber campanhas).';
        } else if (eligibleCount > CAMPAIGN_DISPATCH_LIMIT) {
            hint.textContent = `${eligibleCount} leads elegíveis, mas o disparo é limitado a ${CAMPAIGN_DISPATCH_LIMIT} por vez (limite diário da Meta pra contas Tier 1). Repita o disparo depois pra alcançar o restante.`;
        } else {
            hint.textContent = `Arraste pra limitar quantos dos ${eligibleCount} leads elegíveis recebem esse disparo.`;
        }
    }
}

// === CUSTO DO DISPARO (tarifa por mensagem, por categoria de template) ===
let cachedWhatsappPricingRates = null;

async function getWhatsappPricingRates() {
    if (cachedWhatsappPricingRates) return cachedWhatsappPricingRates;
    try {
        const res = await fetch('/api/settings/whatsapp-pricing');
        const json = await res.json();
        cachedWhatsappPricingRates = json.rates || { MARKETING: 0.3125, UTILITY: 0.0340, AUTHENTICATION: 0.0340 };
    } catch (e) {
        cachedWhatsappPricingRates = { MARKETING: 0.3125, UTILITY: 0.0340, AUTHENTICATION: 0.0340 };
    }
    return cachedWhatsappPricingRates;
}

// Tela de confirmação antes de qualquer disparo em massa — mostra o custo
// estimado (destinatários × tarifa da categoria do template) em vez do
// confirm() nativo do navegador, que não passava informação nenhuma pro
// atendente antes de sair enviando mensagem pra centenas de pacientes.
const DISPATCH_CATEGORY_LABELS = { MARKETING: 'Marketing', UTILITY: 'Utilidade', AUTHENTICATION: 'Autenticação' };

function showDispatchConfirmModal({ templateName, category, recipientCount, costPerMessage }) {
    return new Promise(resolve => {
        const modal = document.getElementById('modalDispatchConfirm');
        const confirmBtn = document.getElementById('dispatch-confirm-btn');
        const cancelBtn = document.getElementById('dispatch-cancel-btn');
        const warningEl = document.getElementById('dispatch-confirm-warning');
        if (!modal || !confirmBtn || !cancelBtn) { resolve(true); return; } // rede de segurança se o modal não existir

        const total = recipientCount * costPerMessage;
        const fmtBRL = (v) => 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        document.getElementById('dispatch-confirm-template').textContent = templateName;
        document.getElementById('dispatch-confirm-category').textContent = DISPATCH_CATEGORY_LABELS[category] || category;
        document.getElementById('dispatch-confirm-count').textContent = `${recipientCount} paciente${recipientCount === 1 ? '' : 's'}`;
        document.getElementById('dispatch-confirm-rate').textContent = fmtBRL(costPerMessage);
        document.getElementById('dispatch-confirm-total').textContent = fmtBRL(total);
        warningEl.style.display = recipientCount > 200 ? 'block' : 'none';

        const cleanup = (result) => {
            modal.classList.remove('active');
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
            resolve(result);
        };
        const onConfirm = () => cleanup(true);
        const onCancel = () => cleanup(false);

        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);
        modal.classList.add('active');
    });
}

// Sincroniza os chips de "tempo de resposta" com o valor guardado no input hidden.
function setAiDelay(btn) {
    const value = btn ? btn.getAttribute('data-delay') : '0';
    const hidden = document.getElementById('whatsapp-ai-delay');
    if (hidden) hidden.value = value;
    document.querySelectorAll('#whatsapp-ai-delay-chips .aix-chip').forEach(c => c.classList.remove('active'));
    if (btn) btn.classList.add('active');
}

function applyAiDelayToChips(seconds) {
    const s = String(parseInt(seconds, 10) || 0);
    const hidden = document.getElementById('whatsapp-ai-delay');
    if (hidden) hidden.value = s;
    const chips = document.querySelectorAll('#whatsapp-ai-delay-chips .aix-chip');
    let matched = false;
    chips.forEach(c => {
        const on = c.getAttribute('data-delay') === s;
        c.classList.toggle('active', on);
        if (on) matched = true;
    });
    if (!matched && chips[0]) chips[0].classList.add('active');
}

const AI_MODE_DESCRIPTIONS = {
    qualificacao: 'Entende a necessidade do lead e passa rápido para um atendente — não fala de preço.',
    vendas: 'Apresenta o procedimento, trata objeções e conduz o lead até aceitar agendar uma avaliação. Passa para o atendente na hora de fechar. Continua sem inventar preço.'
};

// Sincroniza os chips de "modo do agente" com o input hidden + atualiza a descrição.
function setAiMode(btn) {
    const value = btn ? btn.getAttribute('data-mode') : 'qualificacao';
    const hidden = document.getElementById('whatsapp-ai-mode');
    if (hidden) hidden.value = value;
    document.querySelectorAll('#whatsapp-ai-mode-chips .aix-chip').forEach(c => c.classList.remove('active'));
    if (btn) btn.classList.add('active');
    const desc = document.getElementById('whatsapp-ai-mode-desc');
    if (desc) desc.textContent = AI_MODE_DESCRIPTIONS[value] || '';
}

function applyAiModeToChips(mode) {
    const m = mode === 'vendas' ? 'vendas' : 'qualificacao';
    const hidden = document.getElementById('whatsapp-ai-mode');
    if (hidden) hidden.value = m;
    const chips = document.querySelectorAll('#whatsapp-ai-mode-chips .aix-chip');
    chips.forEach(c => c.classList.toggle('active', c.getAttribute('data-mode') === m));
    const desc = document.getElementById('whatsapp-ai-mode-desc');
    if (desc) desc.textContent = AI_MODE_DESCRIPTIONS[m] || '';
}

// Chips de "intervalo" do detector de oportunidades (mesmo padrão de setAiDelay).
function setOppsIntervalo(btn) {
    const value = btn ? btn.getAttribute('data-h') : '8';
    const hidden = document.getElementById('opps-intervalo');
    if (hidden) hidden.value = value;
    document.querySelectorAll('#opps-intervalo-chips .aix-chip').forEach(c => c.classList.remove('active'));
    if (btn) btn.classList.add('active');
}
function applyOppsIntervaloToChips(horas) {
    const h = String(parseInt(horas, 10) || 8);
    const hidden = document.getElementById('opps-intervalo');
    if (hidden) hidden.value = h;
    const chips = document.querySelectorAll('#opps-intervalo-chips .aix-chip');
    let matched = false;
    chips.forEach(c => { const on = c.getAttribute('data-h') === h; c.classList.toggle('active', on); if (on) matched = true; });
    if (!matched && chips[1]) chips[1].classList.add('active'); // cai no "8h"
}
function renderOppsStatus(lastRun) {
    const el = document.getElementById('opps-status');
    if (!el) return;
    if (!lastRun) { el.textContent = 'Ainda não rodou.'; return; }
    const d = parseSqlDate(lastRun);
    el.textContent = d ? ('Última varredura: ' + d.toLocaleString('pt-BR')) : ('Última varredura: ' + lastRun);
}
async function runOppsNow(btn) {
    if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }
    try {
        const res = await fetch('/api/opps/run', { method: 'POST' });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || 'Falhou');
        const r = j.result || {};
        await customAlert(
            `Varredura concluída.\nCandidatos: ${r.candidatos ?? 0} · Com intenção: ${r.com_intencao ?? 0} · Analisados pela IA: ${r.analisados ?? 0} · Oportunidades sinalizadas: ${r.sinalizados ?? 0}`,
            'Detector de oportunidades'
        );
        try { const c = await (await fetch('/api/opps/config')).json(); renderOppsStatus(c.last_run); } catch (e) {}
    } catch (e) {
        await customAlert('Erro: ' + e.message, 'Detector de oportunidades');
    } finally {
        if (btn) { btn.disabled = false; btn.style.opacity = ''; }
    }
}

async function openWhatsappAiSettingsModal() {
    try {
        const [toggleRes, contextRes, oppsRes] = await Promise.all([
            fetch('/api/settings/whatsapp-ai'),
            fetch('/api/settings/whatsapp-ai-context'),
            fetch('/api/opps/config')
        ]);
        const toggleJson = await toggleRes.json();
        const contextJson = await contextRes.json();
        document.getElementById('whatsapp-ai-global-toggle').checked = !!toggleJson.enabled;
        document.getElementById('whatsapp-ai-context-textarea').value = contextJson.context || '';
        applyAiDelayToChips(toggleJson.delaySeconds);
        applyAiModeToChips(toggleJson.mode);
        const humanEl = document.getElementById('whatsapp-ai-human');
        const typingEl = document.getElementById('whatsapp-ai-typing');
        const visionEl = document.getElementById('whatsapp-ai-vision');
        const audioEl = document.getElementById('whatsapp-ai-audio');
        if (humanEl) humanEl.checked = toggleJson.human !== false;   // liga por padrão
        if (typingEl) typingEl.checked = toggleJson.typing !== false;
        if (visionEl) visionEl.checked = toggleJson.vision !== false;
        if (audioEl) audioEl.checked = toggleJson.audio !== false;

        try {
            const oppsJson = await oppsRes.json();
            const oc = oppsJson.config || {};
            const at = document.getElementById('opps-ativo');
            if (at) at.checked = oc.ativo !== false;
            applyOppsIntervaloToChips(oc.intervalo_horas);
            const pw = document.getElementById('opps-palavras');
            if (pw) pw.value = oc.palavras_chave || '';
            renderOppsStatus(oppsJson.last_run);
        } catch (e) { console.error('Erro ao buscar config de oportunidades:', e); }
    } catch (e) {
        console.error('Erro ao buscar configuração da IA:', e);
    }
    document.getElementById('modalWhatsappAiSettings').classList.add('active');
}

async function saveWhatsappAiSettings() {
    const enabled = document.getElementById('whatsapp-ai-global-toggle').checked;
    const context = document.getElementById('whatsapp-ai-context-textarea').value;
    const delaySeconds = parseInt((document.getElementById('whatsapp-ai-delay') || {}).value, 10) || 0;
    const mode = (document.getElementById('whatsapp-ai-mode') || {}).value || 'qualificacao';
    const human = !!(document.getElementById('whatsapp-ai-human') || {}).checked;
    const typing = !!(document.getElementById('whatsapp-ai-typing') || {}).checked;
    const vision = !!(document.getElementById('whatsapp-ai-vision') || {}).checked;
    const audio = !!(document.getElementById('whatsapp-ai-audio') || {}).checked;
    const oppsAtivo = !!(document.getElementById('opps-ativo') || {}).checked;
    const oppsIntervalo = parseInt((document.getElementById('opps-intervalo') || {}).value, 10) || 8;
    const oppsPalavras = (document.getElementById('opps-palavras') || {}).value || '';
    try {
        const [toggleRes, contextRes, oppsRes] = await Promise.all([
            fetch('/api/settings/whatsapp-ai', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled, delaySeconds, mode, human, typing, vision, audio })
            }),
            fetch('/api/settings/whatsapp-ai-context', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ context })
            }),
            fetch('/api/opps/config', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ativo: oppsAtivo, intervalo_horas: oppsIntervalo, palavras_chave: oppsPalavras })
            })
        ]);
        const toggleJson = await toggleRes.json();
        const contextJson = await contextRes.json();
        if (!toggleRes.ok) throw new Error(toggleJson.error || 'Erro ao salvar interruptor da IA');
        if (!contextRes.ok) throw new Error(contextJson.error || 'Erro ao salvar contexto da IA');
        if (!oppsRes.ok) { const oj = await oppsRes.json().catch(() => ({})); throw new Error(oj.error || 'Erro ao salvar detector de oportunidades'); }
        closeModals();
        await customAlert('Configuração do agente de IA atualizada!', 'Salvo com Sucesso');
    } catch (e) {
        await customAlert('Erro ao salvar: ' + e.message, 'Erro');
    }
}

async function openWhatsappPricingEditor() {
    const rates = await getWhatsappPricingRates();
    document.getElementById('pricing-marketing').value = rates.MARKETING;
    document.getElementById('pricing-utility').value = rates.UTILITY;
    document.getElementById('pricing-authentication').value = rates.AUTHENTICATION;
    document.getElementById('modalWhatsappPricing').classList.add('active');
}

async function saveWhatsappPricingEditor() {
    const marketing = document.getElementById('pricing-marketing').value;
    const utility = document.getElementById('pricing-utility').value;
    const authentication = document.getElementById('pricing-authentication').value;

    try {
        const res = await fetch('/api/settings/whatsapp-pricing', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ MARKETING: marketing, UTILITY: utility, AUTHENTICATION: authentication })
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Erro ao salvar tarifas');
        cachedWhatsappPricingRates = json.rates;
        closeModals();
        await customAlert('Tarifas atualizadas!', 'Tarifas Salvas');
    } catch (e) {
        await customAlert('Erro ao salvar tarifas: ' + e.message, 'Erro');
    }
}

async function loadDispatchHistory() {
    const box = document.getElementById('dispatch-history-list');
    if (!box) return;
    try {
        const res = await fetch('/api/whatsapp/dispatches');
        const json = await res.json();
        const dispatches = json.dispatches || [];
        if (dispatches.length === 0) {
            box.innerHTML = `<div class="utm-empty-state" style="padding: 1rem;"><span>Nenhum disparo registrado ainda.</span></div>`;
            return;
        }
        box.innerHTML = `
            <table style="width: 100%; border-collapse: collapse; font-size: 0.82rem;">
                <thead>
                    <tr style="text-align: left; color: var(--text-muted); border-bottom: 1px solid var(--border-color);">
                        <th style="padding: 0.5rem;">Data</th>
                        <th style="padding: 0.5rem;">Template</th>
                        <th style="padding: 0.5rem;">Categoria</th>
                        <th style="padding: 0.5rem; text-align: right;">Enviados</th>
                        <th style="padding: 0.5rem; text-align: right;">Custo</th>
                    </tr>
                </thead>
                <tbody>
                    ${dispatches.map(d => `
                        <tr style="border-bottom: 1px solid var(--border-color);">
                            <td style="padding: 0.5rem; color: var(--text-muted);">${new Date(d.created_at).toLocaleString('pt-BR')}</td>
                            <td style="padding: 0.5rem; color: var(--text-main);">${escapeHtml(d.template_name || '')}</td>
                            <td style="padding: 0.5rem; color: var(--text-muted);">${escapeHtml(d.category || '')}</td>
                            <td style="padding: 0.5rem; text-align: right; color: var(--text-main);">${d.success_count}/${d.total_leads}</td>
                            <td style="padding: 0.5rem; text-align: right; color: var(--accent-success); font-weight: 600;">R$ ${Number(d.cost_total || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    } catch (e) {
        box.innerHTML = `<div class="utm-empty-state" style="padding: 1rem;"><span>Erro ao carregar histórico de disparos.</span></div>`;
    }
}

async function startCampaign() {
    const selectEl = document.getElementById('campaign-template-select');
    const selectedValue = selectEl ? selectEl.value : '';
    if (!selectedValue) {
        alert("Selecione um template aprovado!");
        return;
    }
    // O idioma vem junto no value (formato "nome|idioma") — não é mais escolhido
    // à parte, pra não repetir o erro de mandar um idioma que o template não tem.
    const [templateName, languageCode] = selectedValue.split('|');

    // Se o corpo do template tem variável — numérica tipo "Olá {{1}}" ou nomeada tipo
    // "Oi {{customer_name}}" (formato mais novo da Meta) — a API exige um parâmetro
    // pra cada uma, sem isso o envio falha com o erro #132000 "Number of parameters
    // does not match". Hoje só suportamos o caso mais comum (uma variável = nome do
    // lead); templates com mais de uma são bloqueados aqui pra não mandar disparo
    // pela metade pra centenas de leads.
    const selectedTemplate = cachedWhatsappTemplates.find(t => t.name === templateName && t.language === languageCode);
    // Categoria vem pronta da Meta (MARKETING/UTILITY/AUTHENTICATION) — desde jan/2026
    // ela cobra por mensagem enviada, tarifa fixa por categoria, então já dá pra saber
    // o custo antes mesmo de enviar. UTILITY como fallback (tarifa mais baixa) se a
    // categoria não vier por algum motivo.
    const templateCategory = (selectedTemplate && selectedTemplate.category) || 'UTILITY';
    const pricingRates = await getWhatsappPricingRates();
    const costPerMessage = pricingRates[templateCategory] ?? pricingRates.UTILITY;
    const bodyComponent = selectedTemplate ? (selectedTemplate.components || []).find(c => c.type === 'BODY') : null;
    const bodyVarMatches = bodyComponent && bodyComponent.text ? (bodyComponent.text.match(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g) || []) : [];
    const bodyVarCount = bodyVarMatches.length;
    // Nome do parâmetro se for variável nomeada (ex: "customer_name"); undefined se
    // for posicional (ex: "1") — a Meta exige "parameter_name" só no formato nomeado.
    const bodyVarName = bodyVarMatches[0] ? bodyVarMatches[0].replace(/[{}\s]/g, '') : null;
    const isNamedParam = bodyVarName && !/^\d+$/.test(bodyVarName);
    if (bodyVarCount > 1) {
        alert(`O template "${templateName}" tem ${bodyVarCount} variáveis no corpo. Disparo em massa hoje só suporta templates sem variável ou com uma única variável (preenchida com o nome do lead).`);
        return;
    }

    const targetCol = document.getElementById('campaign-target').value;
    const btn = document.getElementById('btn-start-campaign');
    const logBox = document.getElementById('campaign-log');
    const statusText = document.getElementById('campaign-status');
    const progressText = document.getElementById('campaign-progress-text');
    const progressBar = document.getElementById('campaign-progress-bar');

    if (targetCol === 'all') {
        if (!confirm("Tem certeza que deseja disparar para TODOS os leads cadastrados? Isso pode gerar custos na API da Meta.")) {
            return;
        }
    }

    // ===== PROTEÇÕES ANTI-BLOQUEIO DA CONTA META =====
    // 1) Opt-out do lead. 2) Exige conversa real por WhatsApp (opt-in confirmado).
    // 3) Não repete o mesmo template pra quem já recebeu, se a caixinha estiver marcada.
    const skipRepeatedEl = document.getElementById('campaign-skip-repeated');
    const skipRepeated = skipRepeatedEl ? skipRepeatedEl.checked : true;

    let optedOutCount = 0, noHistoryCount = 0, repeatedCount = 0, targetLeads = [];
    try {
        const result = await getEligibleCampaignLeads(targetCol, templateName, skipRepeated);
        targetLeads = result.eligible;
        optedOutCount = result.optedOutCount;
        noHistoryCount = result.noHistoryCount;
        repeatedCount = result.repeatedCount;
    } catch (e) {
        console.error('Não foi possível checar elegibilidade dos leads antes da campanha:', e);
        await customAlert('Não foi possível verificar quais leads são elegíveis pra essa campanha. Por segurança, o disparo foi cancelado — tente novamente.', 'Disparo cancelado');
        return;
    }

    if (targetLeads.length === 0) {
        await customAlert("Nenhum lead elegível: todos já receberam esse template, nunca conversaram por WhatsApp, ou pediram pra não receber campanhas.", 'Nenhum lead elegível');
        return;
    }

    // 4) Respeita o limite escolhido no slider "Quantidade de Leads" — corta a lista
    // pros N primeiros elegíveis, pra permitir disparos em lotes controlados.
    const limitSlider = document.getElementById('campaign-lead-limit');
    const leadLimit = limitSlider ? parseInt(limitSlider.value, 10) : targetLeads.length;
    const cutByLimit = leadLimit > 0 && leadLimit < targetLeads.length;
    if (cutByLimit) {
        targetLeads = targetLeads.slice(0, leadLimit);
    }

    let confirmMsg = `Você está prestes a disparar o template "${templateName}" para ${targetLeads.length} leads.`;
    if (optedOutCount > 0) confirmMsg += `\n${optedOutCount} lead(s) pulado(s) por terem pedido pra não receber campanhas.`;
    if (noHistoryCount > 0) confirmMsg += `\n${noHistoryCount} lead(s) pulado(s) por nunca terem mandado mensagem no WhatsApp (sem opt-in confirmado).`;
    if (repeatedCount > 0) confirmMsg += `\n${repeatedCount} lead(s) pulado(s) por já terem recebido esse template antes.`;
    if (cutByLimit) confirmMsg += `\nLimitado a ${leadLimit} leads pelo slider de quantidade.`;
    if (targetLeads.length > 200) {
        confirmMsg += `\n\n⚠️ Esse volume é grande. Contas novas/não verificadas na Meta têm limite de 250 mensagens/dia — disparar tudo de uma vez pode estourar seu limite ou derrubar sua nota de qualidade. Considere dividir em lotes menores ao longo do dia.`;
    }
    confirmMsg += '\nContinuar?';

    if (!await customConfirm(confirmMsg, 'Disparar Campanha')) {
        return;
    }

    const costText = document.getElementById('campaign-cost-text');
    await dispatchTemplateCampaign(targetLeads, {
        templateName, languageCode, templateCategory, costPerMessage,
        bodyVarCount, isNamedParam, bodyVarName,
        targetLabel: targetCol,
        els: { btn, logBox, statusText, progressText, progressBar, costText }
    });
}

// Motor genérico de disparo de template em massa, extraído de startCampaign() pra
// poder ser reaproveitado por qualquer tela que precise mandar o mesmo template pra
// uma lista de destinatários (ex: campanhas de reativação de Faltantes/Sumidos/
// Pós-venda/Aniversariantes, que não vêm do Kanban de leads).
// recipients: [{ id, nome, telefone }]. els: { btn, logBox, statusText, progressText,
// progressBar, costText? }. onResult(recipient, success) é chamado após cada envio,
// opcional — usado por quem chama pra registrar "contactado" só em sucesso real.
async function dispatchTemplateCampaign(recipients, opts) {
    const {
        templateName, languageCode, templateCategory, costPerMessage,
        bodyVarCount, isNamedParam, bodyVarName, targetLabel, els, onResult
    } = opts;
    const { btn, logBox, statusText, progressText, progressBar, costText } = els;

    const originalBtnHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="amicro-loader"><span></span><span></span><span></span></span> Disparando...';
    logBox.innerHTML = `<div>Iniciando campanha para ${recipients.length} leads...</div>`;
    statusText.innerText = "Em progresso...";
    statusText.style.color = "var(--accent-info)";
    progressBar.style.transform = 'scaleX(0)';

    let successCount = 0;
    let failCount = 0;
    let costTotal = 0;
    if (costText) costText.innerText = 'Custo estimado: R$ 0,00';

    for (let i = 0; i < recipients.length; i++) {
        const lead = recipients[i];
        let phone = String(lead.telefone || '').replace(/\D/g, '');
        if (!phone.startsWith('55') && phone.length <= 11) {
            phone = '55' + phone;
        }

        let success = false;
        try {
            const res = await fetch('/api/whatsapp/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    to: phone,
                    isTemplate: true,
                    templateName: templateName,
                    languageCode: languageCode,
                    templateParams: bodyVarCount === 1
                        ? [{ text: lead.nome || 'Cliente', parameter_name: isNamedParam ? bodyVarName : undefined }]
                        : undefined,
                    message: "template" // Placeholder required by backend
                })
            });

            const data = await res.json();
            if (data.success) {
                success = true;
                successCount++;
                costTotal += costPerMessage;
                if (costText) costText.innerText = 'Custo estimado: R$ ' + costTotal.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
                logBox.innerHTML += `<div style="color: var(--accent-success);">[OK] ${lead.nome} (${phone})</div>`;
            } else {
                failCount++;
                logBox.innerHTML += `<div style="color: var(--accent-danger);">[FALHA] ${lead.nome} (${phone}): ${data.error || 'Erro'}</div>`;
            }
        } catch (e) {
            failCount++;
            logBox.innerHTML += `<div style="color: var(--accent-danger);">[FALHA] ${lead.nome} (${phone}): ${e.message}</div>`;
        }

        if (typeof onResult === 'function') {
            try { onResult(lead, success); } catch (e) { console.error('Erro no callback pós-envio:', e); }
        }

        const pct = Math.round(((i + 1) / recipients.length) * 100);
        progressBar.style.transform = `scaleX(${(pct / 100).toFixed(3)})`;
        progressText.innerText = `${i + 1} / ${recipients.length} processados`;
        logBox.scrollTop = logBox.scrollHeight;

        // Rate limit: ~1-1.6s entre mensagens, com variação, pra não ter um padrão
        // perfeitamente robótico de envio (um dos sinais que a Meta usa pra detectar spam).
        const jitterDelay = 1000 + Math.floor(Math.random() * 600);
        await new Promise(r => setTimeout(r, jitterDelay));
    }

    btn.disabled = false;
    btn.innerHTML = originalBtnHtml;
    statusText.innerText = `Concluído: ${successCount} Sucessos, ${failCount} Falhas.`;
    statusText.style.color = failCount === 0 ? "var(--accent-success)" : "var(--accent-warning)";
    logBox.innerHTML += `<div><strong>Campanha finalizada!</strong></div>`;
    logBox.scrollTop = logBox.scrollHeight;

    try {
        await fetch('/api/whatsapp/dispatches', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                template_name: templateName,
                category: templateCategory,
                target_column: targetLabel,
                total_leads: recipients.length,
                success_count: successCount,
                fail_count: failCount,
                cost_total: costTotal
            })
        });
        if (typeof loadDispatchHistory === 'function') loadDispatchHistory();
    } catch (e) {
        console.error('Erro ao salvar disparo no histórico:', e);
    }

    return { successCount, failCount, costTotal };
}

// === TEMPLATES DE MENSAGEM (Meta) ===
let cachedWhatsappTemplates = [];

const TEMPLATE_STATUS_INFO = {
    APPROVED: { label: 'Aprovado', color: 'var(--accent-success)' },
    PENDING: { label: 'Pendente', color: 'var(--accent-warning)' },
    REJECTED: { label: 'Rejeitado', color: 'var(--accent-danger)' },
    PAUSED: { label: 'Pausado', color: 'var(--accent-warning)' },
    DISABLED: { label: 'Desativado', color: 'var(--text-muted)' }
};

async function loadWhatsappTemplates() {
    const listEl = document.getElementById('templates-list');
    const selectEl = document.getElementById('campaign-template-select');
    if (listEl) listEl.innerHTML = `<div class="utm-empty-state" style="flex: 1; justify-content: center;"><span class="amicro-loader" style="font-size: 1.6rem;"><span></span><span></span><span></span></span><span>Carregando templates...</span></div>`;

    try {
        const res = await fetch('/api/whatsapp/templates');
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Erro ao carregar templates');

        cachedWhatsappTemplates = json.data || [];
        renderWhatsappTemplatesList();
        renderCampaignTemplateSelect();
    } catch (e) {
        const isWabaMissing = /META_WABA_ID/i.test(e.message || '');
        if (listEl) listEl.innerHTML = `
            <div class="utm-empty-state" style="flex: 1; justify-content: center;">
                <i class="fa-solid fa-triangle-exclamation" style="font-size: 1.8rem; color: var(--accent-danger);"></i>
                <strong style="color: var(--text-main); font-size: 0.92rem;">Não foi possível carregar os templates</strong>
                <span style="max-width: 360px;">${escapeHtml(e.message)}</span>
                ${isWabaMissing ? `<span style="max-width: 360px; font-size: 0.76rem;">Precisa cadastrar o <code style="background: rgba(255,255,255,0.06); padding: 0.1rem 0.4rem; border-radius: 4px;">META_WABA_ID</code> (ID da conta comercial do WhatsApp) no <code style="background: rgba(255,255,255,0.06); padding: 0.1rem 0.4rem; border-radius: 4px;">.env</code> do servidor.</span>` : ''}
            </div>`;
        if (selectEl) selectEl.innerHTML = '<option value="">Falha ao carregar templates</option>';
    }
}

function renderWhatsappTemplatesList() {
    const listEl = document.getElementById('templates-list');
    if (!listEl) return;

    // Só exibe os templates ativos (aprovados pela Meta) — criação/edição agora é
    // feita direto no Gerenciador de Templates do Facebook, não mais por aqui.
    const activeTemplates = cachedWhatsappTemplates.filter(t => t.status === 'APPROVED');

    if (activeTemplates.length === 0) {
        listEl.innerHTML = `
            <div class="utm-empty-state" style="flex: 1; justify-content: center;">
                <i class="fa-regular fa-file-lines" style="font-size: 1.8rem;"></i>
                <strong style="color: var(--text-main); font-size: 0.92rem;">Nenhum template ativo ainda</strong>
                <span style="max-width: 320px;">Crie e aprove um template no Gerenciador da Meta clicando em "Criar no Facebook" acima — ele aparece aqui assim que for aprovado.</span>
            </div>`;
        return;
    }

    listEl.innerHTML = activeTemplates.map(t => {
        const info = TEMPLATE_STATUS_INFO[t.status] || { label: t.status, color: 'var(--text-muted)' };
        const bodyComp = (t.components || []).find(c => c.type === 'BODY');
        return `
        <div style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: 8px; padding: 0.7rem 0.9rem; display: flex; align-items: center; gap: 0.8rem;">
            <div style="flex: 1; min-width: 0;">
                <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                    <strong style="color: var(--text-main); font-size: 0.88rem;">${escapeHtml(t.name)}</strong>
                    <span style="font-size: 0.68rem; font-weight: 700; color: ${info.color}; background: rgba(255,255,255,0.06); padding: 0.1rem 0.5rem; border-radius: 20px;">${info.label}</span>
                    <span style="font-size: 0.7rem; color: var(--text-muted);">${escapeHtml(t.category || '')} · ${escapeHtml(t.language || '')}</span>
                </div>
                ${bodyComp ? `<div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 0.25rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(bodyComp.text || '')}</div>` : ''}
            </div>
            <button type="button" onclick="deleteWhatsappTemplate('${t.name.replace(/'/g, "\\'")}')" title="Excluir template" style="background: none; border: none; color: var(--accent-danger); cursor: pointer; padding: 0.35rem; flex-shrink: 0;"><i class="fa-solid fa-trash"></i></button>
        </div>`;
    }).join('');
}

function renderCampaignTemplateSelect() {
    const selectEl = document.getElementById('campaign-template-select');
    if (!selectEl) return;

    const approved = cachedWhatsappTemplates.filter(t => t.status === 'APPROVED');
    if (approved.length === 0) {
        selectEl.innerHTML = '<option value="">Nenhum template aprovado ainda</option>';
        return;
    }
    selectEl.innerHTML = approved.map(t => `<option value="${escapeHtml(t.name)}|${escapeHtml(t.language)}">${escapeHtml(t.name)} (${escapeHtml(t.language)})</option>`).join('');
}

async function deleteWhatsappTemplate(name) {
    if (!await customConfirm(`Excluir o template "${name}" da Meta? Essa ação não pode ser desfeita.`, 'Excluir Template')) return;
    try {
        const res = await fetch(`/api/whatsapp/templates/${encodeURIComponent(name)}`, { method: 'DELETE' });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Erro ao excluir template');
        if (typeof showToast === 'function') showToast('Template excluído.', 'success');
        await loadWhatsappTemplates();
    } catch (e) {
        alert(e.message);
    }
}


// === CONTROLE DE MENU DE OPÇÕES DO CARD (⋮ e botão direito) ===
let activeCardMenuId = null;

// Ordem do funil pra "mover pra próxima etapa" (Follow Up / col-perdido fica de fora).
const KANBAN_FUNNEL_ORDER = ['col-entrada', 'col-contatado', 'col-orcado', 'col-agendado', 'col-ganho'];

function closeCardMenu() {
    const menu = document.getElementById('card-global-dropdown');
    if (menu) menu.style.display = 'none';
    activeCardMenuId = null;
}

// Núcleo: mostra o menu numa coordenada da viewport (menu é position:fixed).
function showCardMenu(leadId, x, y) {
    const menu = document.getElementById('card-global-dropdown');
    if (!menu) return;
    activeCardMenuId = leadId;

    const lead = leads.find(l => l.id === leadId);

    // volta pra visão principal (some o submenu de etiquetas)
    const main = document.getElementById('card-ctx-main');
    const tags = document.getElementById('card-ctx-tags');
    if (main) main.style.display = 'flex';
    if (tags) { tags.style.display = 'none'; tags.innerHTML = ''; }

    // item Orçamento só quando faz sentido
    const orcItem = document.getElementById('card-menu-item-orc');
    if (orcItem) {
        const show = lead && (lead.column === 'col-orcado' || parseOrcamentoArray(lead.orcamento).length > 0);
        orcItem.style.display = show ? 'flex' : 'none';
    }
    // rótulo do "avançar" com o nome da próxima etapa
    const avLabel = document.getElementById('card-ctx-avancar-label');
    if (avLabel && lead) {
        const i = KANBAN_FUNNEL_ORDER.indexOf(lead.column);
        const next = i >= 0 && i < KANBAN_FUNNEL_ORDER.length - 1 ? KANBAN_FUNNEL_ORDER[i + 1] : null;
        avLabel.textContent = next ? `Mover p/ ${(KANBAN_COLUMNS[next] || {}).label || 'próxima etapa'}` : 'Já na última etapa';
        avLabel.parentElement.disabled = !next;
    }

    menu.style.display = 'block';
    // mede depois de exibir pra saber o tamanho real e não estourar a tela
    const r = menu.getBoundingClientRect();
    let left = x, top = y;
    if (left + r.width > window.innerWidth - 8) left = window.innerWidth - r.width - 8;
    if (top + r.height > window.innerHeight - 8) top = window.innerHeight - r.height - 8;
    menu.style.left = Math.max(8, left) + 'px';
    menu.style.top = Math.max(8, top) + 'px';
}

window.toggleCardDropdown = function(event, leadId) {
    event.preventDefault();
    event.stopPropagation();
    const menu = document.getElementById('card-global-dropdown');
    if (!menu) return;
    if (menu.style.display === 'block' && activeCardMenuId === leadId) { closeCardMenu(); return; }
    const rect = event.currentTarget.getBoundingClientRect();
    showCardMenu(leadId, rect.left - 170, rect.bottom + 4);
};

// Botão direito em cima do card abre o mesmo menu, no cursor.
window.openCardContextMenu = function(event, leadId) {
    event.preventDefault();
    event.stopPropagation();
    showCardMenu(leadId, event.clientX, event.clientY);
};

// Fecha ao clicar/right-click fora
['click', 'contextmenu'].forEach(evt => document.addEventListener(evt, function(e) {
    const menu = document.getElementById('card-global-dropdown');
    if (!menu || menu.style.display !== 'block') return;
    if (menu.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.card-options-btn')) return;
    if (evt === 'contextmenu' && e.target.closest && e.target.closest('.card')) return; // deixa o card reabrir
    closeCardMenu();
}));

window.triggerCardAction = async function(action) {
    const leadId = activeCardMenuId;
    if (!leadId) return;
    const lead = leads.find(l => l.id === leadId);
    if (!lead) return;

    // Etiquetas abre um submenu — não fecha o menu.
    if (action === 'etiquetas') { renderCardCtxTags(leadId); return; }

    closeCardMenu();

    if (action === 'chat') {
        openLeadChat(lead.telefone, lead.nome);
    } else if (action === 'ficha') {
        openNotesModal(leadId);
    } else if (action === 'orcamento') {
        openOrcamentoModal(leadId);
    } else if (action === 'avancar') {
        advanceLeadStage(leadId);
    } else if (action === 'inativar') {
        if (await customConfirm(`Inativar "${lead.nome || 'este lead'}"? Ele vai para Follow Up e o agente de IA para de responder essa conversa.`, 'Inativar lead')) {
            inativarLead(leadId);
        }
    } else if (action === 'excluir') {
        deleteLead(leadId);
    }
};

// Move o lead pra próxima etapa do funil, com os mesmos modais do drag-and-drop.
async function advanceLeadStage(leadId) {
    const lead = leads.find(l => l.id === leadId);
    if (!lead) return;
    const i = KANBAN_FUNNEL_ORDER.indexOf(lead.column);
    if (i < 0 || i >= KANBAN_FUNNEL_ORDER.length - 1) {
        showToast('Este lead já está na última etapa.', 'success');
        return;
    }
    const target = KANBAN_FUNNEL_ORDER[i + 1];
    lead.column = target;
    renderBoard();
    await updateLeadColumnOnServer(leadId, target);
    if (target === 'col-agendado') { celebrateAgendamento(); setTimeout(() => openAgendamentoModal(leadId), 400); }
    else if (target === 'col-orcado' && typeof openOrcamentoModal === 'function') { openOrcamentoModal(leadId); }
    else if (target === 'col-ganho') { openNotesModal(leadId); }
}

async function inativarLead(leadId) {
    const lead = leads.find(l => l.id === leadId);
    if (!lead) return;
    lead.column = 'col-perdido';
    lead.ai_enabled = 0;
    renderBoard();
    try {
        await fetch(`/api/leads/${leadId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ column_id: 'col-perdido', ai_enabled: 0 })
        });
        showToast('Lead movido para Follow Up e IA desligada.', 'success');
    } catch (e) {
        showToast('Falha ao inativar o lead.', 'danger');
    }
}

window.backToCardCtxMain = function() {
    const main = document.getElementById('card-ctx-main');
    const box = document.getElementById('card-ctx-tags');
    if (box) { box.style.display = 'none'; box.innerHTML = ''; }
    if (main) main.style.display = 'flex';
};

// Submenu de etiquetas dentro do menu de contexto.
function renderCardCtxTags(leadId) {
    const lead = leads.find(l => l.id === leadId);
    const main = document.getElementById('card-ctx-main');
    const box = document.getElementById('card-ctx-tags');
    if (!lead || !box) return;
    const all = (typeof getAvailableTags === 'function') ? getAvailableTags() : (window.availableTags || []);
    const current = new Set((lead.tags || '').split(',').map(t => t.trim()).filter(Boolean));

    box.innerHTML = `
        <div class="card-ctx-tags-head">
            <button type="button" onclick="backToCardCtxMain()" title="Voltar"><i class="fa-solid fa-chevron-left"></i></button>
            <span><i class="fa-solid fa-tags"></i> Etiquetas</span>
        </div>
        ${all.map(t => {
            const on = current.has(t.id);
            return `<button type="button" class="card-ctx-tag" aria-checked="${on}" onclick="toggleCardCtxTag('${leadId}','${t.id}', this)">
                <i class="fa-solid fa-check card-ctx-tag-check"></i>
                <span class="card-ctx-tag-badge" style="background:${t.bg || 'transparent'};color:${t.color || 'inherit'};border-color:${t.border || t.color || 'var(--border-color)'};">${escapeHtml(t.label || t.id)}</span>
            </button>`;
        }).join('') || '<div style="padding:0.6rem;color:var(--text-muted);font-size:0.8rem;">Nenhuma etiqueta cadastrada.</div>'}
        <div class="card-ctx-sep"></div>
        <button type="button" class="card-ctx-item" onclick="openTagsEditor()">
            <i class="fa-solid fa-gear" style="color: var(--text-muted);"></i> Editar etiquetas
        </button>
    `;
    if (main) main.style.display = 'none';
    box.style.display = 'block';
    // reposiciona caso o submenu tenha outro tamanho
    const menu = document.getElementById('card-global-dropdown');
    const r = menu.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) menu.style.top = Math.max(8, window.innerHeight - r.height - 8) + 'px';
}

// === EDITOR DE ETIQUETAS (modal #modalTags) — reaproveita a persistência do chat ===
let _tgeEditingId = null;

window.openTagsEditor = function() {
    closeCardMenu();
    tgeCancelEdit();
    tgeRenderList();
    const m = document.getElementById('modalTags');
    if (m) m.classList.add('active');
};

function tgeRenderList() {
    const box = document.getElementById('tge-list');
    if (!box) return;
    const tags = (typeof getAvailableTags === 'function') ? getAvailableTags() : [];
    const protectedIds = (typeof PROTECTED_TAG_IDS !== 'undefined') ? PROTECTED_TAG_IDS : [];
    box.innerHTML = tags.length ? tags.map(t => {
        const prot = protectedIds.includes(t.id);
        return `<div style="display:flex; align-items:center; justify-content:space-between; padding:0.45rem 0.6rem; background:var(--bg-main); border:1px solid var(--border-color); border-radius:7px;">
            <span class="card-ctx-tag-badge" style="background:${t.bg};color:${t.color};border-color:${t.border || t.color};">${escapeHtml(t.label || t.id)}</span>
            <span style="display:flex; gap:0.1rem;">
                <button onclick="tgeStartEdit('${t.id}')" title="Editar nome/cor" style="background:none;border:0;color:var(--text-muted);cursor:pointer;padding:0.2rem 0.4rem;font-size:0.85rem;"><i class="fa-solid fa-pen"></i></button>
                ${prot
                    ? `<i class="fa-solid fa-lock" title="Etiqueta usada pelo sistema — não pode ser excluída" style="color:var(--text-muted);padding:0.2rem 0.4rem;font-size:0.8rem;"></i>`
                    : `<button onclick="tgeDelete('${t.id}')" title="Excluir" style="background:none;border:0;color:var(--accent-danger);cursor:pointer;padding:0.2rem 0.4rem;font-size:0.85rem;"><i class="fa-solid fa-trash"></i></button>`}
            </span>
        </div>`;
    }).join('') : '<div style="text-align:center; color:var(--text-muted); font-size:0.83rem; padding:1rem;">Nenhuma etiqueta ainda.</div>';
}

window.tgeStartEdit = function(id) {
    const t = (getAvailableTags() || []).find(x => x.id === id);
    if (!t) return;
    _tgeEditingId = id;
    const n = document.getElementById('tge-name'); if (n) n.value = t.label || '';
    const c = document.getElementById('tge-color'); if (c) c.value = t.color || '#3b82f6';
    const ci = document.getElementById('tge-color-icon'); if (ci) ci.style.color = t.color || '#3b82f6';
    const s = document.getElementById('tge-save-btn'); if (s) s.innerHTML = '<i class="fa-solid fa-check"></i> Salvar';
    const x = document.getElementById('tge-cancel-btn'); if (x) x.style.display = 'inline-flex';
};

window.tgeCancelEdit = function() {
    _tgeEditingId = null;
    const n = document.getElementById('tge-name'); if (n) n.value = '';
    const c = document.getElementById('tge-color'); if (c) c.value = '#3b82f6';
    const ci = document.getElementById('tge-color-icon'); if (ci) ci.style.color = '#3b82f6';
    const s = document.getElementById('tge-save-btn'); if (s) s.innerHTML = '<i class="fa-solid fa-plus"></i> Adicionar';
    const x = document.getElementById('tge-cancel-btn'); if (x) x.style.display = 'none';
};

function tgeAfterChange() {
    tgeRenderList();
    if (typeof renderBoard === 'function') renderBoard();
    const sub = document.getElementById('card-ctx-tags');
    if (activeCardMenuId && sub && sub.style.display === 'block') renderCardCtxTags(activeCardMenuId);
}

window.tgeSave = async function() {
    const name = (document.getElementById('tge-name')?.value || '').trim();
    if (!name) { showToast('Informe o nome da etiqueta.', 'danger'); return; }
    const hex = document.getElementById('tge-color')?.value || '#3b82f6';
    const bg = (typeof hexToRgba === 'function') ? hexToRgba(hex, 0.15) : hex + '26';
    const tags = (getAvailableTags() || []).slice();
    if (_tgeEditingId) {
        const i = tags.findIndex(t => t.id === _tgeEditingId);
        if (i >= 0) tags[i] = { ...tags[i], label: name, bg, color: hex, border: hex };
    } else {
        tags.push({ id: 'custom_' + Date.now(), label: name, bg, color: hex, border: hex });
    }
    await saveAvailableTags(tags);
    tgeCancelEdit();
    tgeAfterChange();
};

window.tgeDelete = async function(id) {
    const protectedIds = (typeof PROTECTED_TAG_IDS !== 'undefined') ? PROTECTED_TAG_IDS : [];
    if (protectedIds.includes(id)) {
        showToast('Essa etiqueta é usada pelo sistema e não pode ser excluída.', 'danger');
        return;
    }
    if (!await customConfirm('Excluir esta etiqueta? Ela some dos cards que a usam.', 'Excluir etiqueta')) return;
    await saveAvailableTags((getAvailableTags() || []).filter(t => t.id !== id));
    tgeAfterChange();
};

window.toggleCardCtxTag = async function(leadId, tagId, btn) {
    const lead = leads.find(l => l.id === leadId);
    if (!lead) return;
    const arr = (lead.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    const idx = arr.indexOf(tagId);
    if (idx >= 0) arr.splice(idx, 1); else arr.push(tagId);
    lead.tags = arr.join(',');
    if (btn) btn.setAttribute('aria-checked', idx >= 0 ? 'false' : 'true');
    renderBoard();
    try {
        await fetch(`/api/leads/${leadId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tags: lead.tags })
        });
    } catch (e) {
        showToast('Falha ao salvar a etiqueta.', 'danger');
    }
};

function showToast(message, type = 'success', duration = 3500) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('toast--visible'));

    const dismiss = () => {
        toast.classList.remove('toast--visible');
        toast.addEventListener('transitionend', () => toast.remove(), { once: true });
        setTimeout(() => toast.remove(), 400);
    };
    const timer = setTimeout(dismiss, duration);
    toast.addEventListener('click', () => { clearTimeout(timer); dismiss(); });
}

// Pause all polling when the tab is backgrounded; resume when foregrounded.
// Sem isso, abas em segundo plano continuavam batendo no D1 a cada poucos
// segundos — cota de rows_read queimada por aba esquecida aberta.
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        ['kanbanSyncInterval', 'dashPollingInterval', 'chatPollingInterval',
         'globalChatCheckInterval', 'heartbeatInterval', 'notifPollInterval'].forEach(key => {
            clearInterval(window[key]);
            window[key] = null;
        });
    } else {
        if (loggedUser && !window.kanbanSyncInterval) {
            window.kanbanSyncInterval = setInterval(() => {
                if (loggedUser) fetchLeadsFromServer(true);
            }, 90000);
        }
        if (!window.globalChatCheckInterval) {
            window.globalChatCheckInterval = setInterval(() => {
                if (typeof loadChats === 'function') loadChats(true);
                if (window.currentActiveChat && document.getElementById('view-chat')?.style.display !== 'none') {
                    if (typeof openChat === 'function') openChat(window.currentActiveChat.phone, window.currentActiveChat.name, true);
                }
            }, 45000);
        }
        if (loggedUser && !window.notifPollInterval && typeof startNotificationPolling === 'function') {
            startNotificationPolling();
        }
        startHeartbeat();
    }
});

// === LEAD PROFILE PANEL ===
const KANBAN_COLUMNS = {
    'col-entrada':     { label: 'Novo Lead',    color: 'var(--accent-primary)', icon: 'fa-star' },
    'col-contatado':   { label: 'Contatado',    color: '#60a5fa',               icon: 'fa-phone' },
    'col-orcado':      { label: 'Orçado',       color: 'var(--accent-warning)', icon: 'fa-file-invoice-dollar' },
    'col-agendado':    { label: 'Agendado',     color: 'var(--accent-success)', icon: 'fa-calendar-check' },
    'col-ganho':       { label: 'Ganho',        color: '#34d399',               icon: 'fa-trophy' },
    'col-perdido':     { label: 'Follow Up',    color: '#fb923c',               icon: 'fa-arrow-rotate-left' },
    'col-atendimento': { label: 'Em Atendimento', color: '#2dd4bf',             icon: 'fa-headset' },
};

let _lppCurrentLeadId = null;

function lppOpenChat() {
    const lead = leads.find(l => l.id === _lppCurrentLeadId);
    if (!lead) return;
    closeLeadProfile();
    openLeadChat(lead.telefone, lead.nome);
}

// Abre o modal de edição do lead (nome, telefone, e-mail, origem, notas, valor…) a partir da ficha.
function lppEditLead() {
    if (!_lppCurrentLeadId) return;
    if (typeof openNotesModal === 'function') openNotesModal(_lppCurrentLeadId);
}

// Para o follow-up automático em andamento a partir da ficha do lead.
async function lppStopFollowup(leadId) {
    try {
        const r = await fetch(`/api/leads/${leadId}/followup/stop`, { method: 'POST' });
        if (!r.ok) { showToast('Não foi possível parar o follow-up.', 'danger'); return; }
        showToast('Follow-up interrompido.', 'success');
        const row = document.getElementById('lpp-followup-row');
        if (row) row.style.display = 'none';
    } catch (e) { showToast('Erro ao parar o follow-up.', 'danger'); }
}

// Alterna entre a prévia resumida e o texto completo das notas.
function lppToggleNotas() {
    const box = document.getElementById('lpp-notas');
    const toggle = document.getElementById('lpp-notas-toggle');
    if (!box) return;
    const clamped = box.classList.toggle('is-clamped');
    if (toggle) toggle.textContent = clamped ? 'Ver mais' : 'Ver menos';
}

function lppCopyPhone(event, phone) {
    event.stopPropagation();
    navigator.clipboard.writeText(phone).then(() => {
        const btn = event.currentTarget;
        btn.innerHTML = '<i class="fa-solid fa-check"></i>';
        btn.classList.add('lpp-copy-phone--copied');
        setTimeout(() => {
            btn.innerHTML = '<i class="fa-regular fa-copy"></i>';
            btn.classList.remove('lpp-copy-phone--copied');
        }, 1800);
    });
}

function lppInitials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

function lppFormatDate(str) {
    if (!str) return null;
    const d = new Date(str.includes('T') ? str : str + 'T12:00:00');
    if (isNaN(d)) return null;
    return d.toLocaleDateString('pt-BR');
}

function lppFormatDateTime(str) {
    if (!str) return null;
    // created_at vem em UTC sem 'Z' — adicionamos 'Z' para o browser interpretar corretamente
    const normalized = str.includes('T') ? str : str.replace(' ', 'T') + 'Z';
    const d = new Date(normalized);
    if (isNaN(d)) return null;
    return d.toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

function lppRelativeTime(str) {
    if (!str) return null;
    const d = new Date(str.includes('T') ? str : str + 'T12:00:00');
    if (isNaN(d)) return null;
    const diff = Date.now() - d.getTime();
    const days = Math.floor(diff / 86400000);
    if (days === 0) return 'hoje';
    if (days === 1) return 'ontem';
    return `há ${days} dias`;
}

function lppBirthdayInfo(bornStr) {
    if (!bornStr) return null;
    const born = new Date(bornStr.includes('T') ? bornStr : bornStr + 'T12:00:00');
    if (isNaN(born)) return null;
    const today = new Date();
    const age = today.getFullYear() - born.getFullYear();
    const nextBday = new Date(today.getFullYear(), born.getMonth(), born.getDate());
    if (nextBday < today) nextBday.setFullYear(today.getFullYear() + 1);
    const daysUntil = Math.round((nextBday - today) / 86400000);
    return {
        date: lppFormatDate(bornStr),
        age: age - (nextBday.getFullYear() > today.getFullYear() ? 1 : 0),
        daysUntil
    };
}

function lppFormatMoney(val) {
    if (!val && val !== 0) return null;
    return Number(val).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function lppParseOrcamento(raw) {
    if (!raw) return [];
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) return [{ id: 'legacy', ...parsed }];
    } catch (_) {}
    return [];
}

async function openLeadProfile(leadId) {
    const lead = leads.find(l => l.id === leadId);
    if (!lead) return;

    _lppCurrentLeadId = leadId;

    const panel = document.getElementById('lead-profile-panel');
    const overlay = document.getElementById('lead-profile-overlay');
    if (!panel) return;

    const chatBtn = document.getElementById('lpp-btn-chat');
    if (chatBtn) chatBtn.style.display = lead.telefone ? '' : 'none';

    // Avatar
    const avatarEl = document.getElementById('lpp-avatar');
    avatarEl.textContent = lppInitials(lead.nome);

    // Nome e contato
    document.getElementById('lpp-name').textContent = lead.nome || '—';
    const contactEl = document.getElementById('lpp-contact');
    contactEl.innerHTML = [
        lead.telefone ? `<span><i class="fa-solid fa-phone" style="width:12px;font-size:0.7rem;"></i> ${lead.telefone}<button class="lpp-copy-phone" title="Copiar número" onclick="lppCopyPhone(event,'${lead.telefone.replace(/'/g,"\\'")}')"><i class="fa-regular fa-copy"></i></button></span>` : '',
        lead.email    ? `<span><i class="fa-solid fa-envelope" style="width:12px;font-size:0.7rem;"></i> <a href="mailto:${lead.email}">${lead.email}</a></span>` : '',
    ].filter(Boolean).join('');

    // Tags
    const tagsEl = document.getElementById('lpp-tags');
    const tagIds = lead.tags ? lead.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
    if (tagIds.length && window.availableTags) {
        tagsEl.innerHTML = tagIds.map(tid => {
            const t = window.availableTags.find(at => at.id == tid || at.name === tid);
            const color = t?.color || '#38bdf8';
            return `<span class="lpp-tag" style="color:${color}; border-color:${color}; background:${color}18">${t?.name || tid}</span>`;
        }).join('');
    } else {
        tagsEl.innerHTML = '';
    }

    // Coluna/etapa
    const colInfo = KANBAN_COLUMNS[lead.column] || { label: lead.column, color: 'var(--text-muted)', icon: 'fa-circle' };
    document.getElementById('lpp-column-badge').innerHTML =
        `<i class="fa-solid ${colInfo.icon}" style="color:${colInfo.color}"></i>
         <span style="color:${colInfo.color}">${colInfo.label}</span>`;
    document.getElementById('lpp-column-badge').style.background = colInfo.color + '18';
    document.getElementById('lpp-column-badge').style.border = `1px solid ${colInfo.color}40`;
    document.getElementById('lpp-column-badge').style.color = colInfo.color;

    // Origem
    const origemEl = document.getElementById('lpp-origem');
    const isMeta = lead.origem && (lead.origem.toLowerCase().includes('meta') || lead.origem.toLowerCase().includes('facebook') || lead.origem.toLowerCase().includes('instagram'));
    const ctwaId = lead.ctwa_clid && String(lead.ctwa_clid).trim();
    const hasFbId = lead.fb_click_id && lead.fb_click_id.trim();
    const clickId = ctwaId || (hasFbId ? lead.fb_click_id : '');
    const clickLabel = ctwaId ? 'ID do Clique Meta (WhatsApp Ads)' : 'ID do Anúncio';
    origemEl.innerHTML = `
        <span class="lpp-origem-badge ${isMeta ? 'lpp-origem-meta' : 'lpp-origem-organic'}">
            <i class="fa-${isMeta ? 'brands fa-meta' : 'solid fa-seedling'}"></i>
            ${lead.origem || 'Orgânico'}
        </span>
        ${clickId ? `<div style="margin-top:0.5rem;">
            <div style="font-size:0.74rem;color:var(--text-muted);margin-bottom:0.25rem;">${clickLabel}</div>
            <span class="lpp-ad-id">${escapeHtml(String(clickId))}</span>
        </div>` : ''}
    `;

    // Informações
    const infoEl = document.getElementById('lpp-info');
    const bday = lppBirthdayInfo(lead.born);
    const relTime = lppRelativeTime(lead.assigned_at || lead.created_at);
    const createdDate = lppFormatDate(lead.created_at);
    const owner = lead.owner_id;

    let bdayHtml = '';
    if (bday) {
        bdayHtml = `
        <div class="lpp-row">
            <i class="fa-solid fa-cake-candles"></i>
            <div>
                <div><span class="lpp-row-label">Nascimento</span> <span class="lpp-row-value">${bday.date} &middot; ${bday.age} anos</span></div>
                ${bday.daysUntil <= 30 ? `<div class="lpp-birthday-alert"><i class="fa-solid fa-party-horn"></i> Aniversário em ${bday.daysUntil} dia${bday.daysUntil !== 1 ? 's' : ''}!</div>` :
                  `<div style="font-size:0.75rem;color:var(--text-muted);margin-top:0.2rem;">Próximo aniversário em ${bday.daysUntil} dias</div>`}
            </div>
        </div>`;
    }

    infoEl.innerHTML = `
        ${createdDate ? `<div class="lpp-row"><i class="fa-solid fa-calendar-plus"></i><span class="lpp-row-label">Criado em</span><span class="lpp-row-value">${createdDate}</span></div>` : ''}
        ${relTime ? `<div class="lpp-row"><i class="fa-solid fa-clock"></i><span class="lpp-row-label">Último contato</span><span class="lpp-row-value">${relTime}</span></div>` : ''}
        ${owner ? `<div class="lpp-row"><i class="fa-solid fa-user-tie"></i><span class="lpp-row-label">Responsável</span><span class="lpp-row-value">${owner}</span></div>` : ''}
        <div class="lpp-row" id="lpp-last-agent-row"><i class="fa-solid fa-headset"></i><span class="lpp-row-label">Último a responder</span><span class="lpp-row-value" id="lpp-last-agent-value">—</span></div>
        <div class="lpp-row" id="lpp-followup-row" style="display:none;"><i class="fa-solid fa-clock-rotate-left"></i><span class="lpp-row-label">Follow-up</span><span class="lpp-row-value" id="lpp-followup-value">—</span></div>
        ${lead.valor_recebido ? `<div class="lpp-row"><i class="fa-solid fa-money-bill-wave"></i><span class="lpp-row-label">Valor recebido</span><span class="lpp-row-value" style="color:var(--accent-success);font-weight:700;">${lppFormatMoney(lead.valor_recebido)}</span></div>` : ''}
        ${bdayHtml}
    `;

    // Follow-up automático em andamento pra esse lead (async).
    (async () => {
        const row = document.getElementById('lpp-followup-row');
        const val = document.getElementById('lpp-followup-value');
        if (!row || !val) return;
        try {
            const r = await fetch(`/api/leads/${leadId}/followup`).then(x => x.json());
            const run = r && r.run;
            if (run && (run.status === 'agendado' || run.status === 'enviando')) {
                const prox = run.next_send_at ? (lppRelativeTime(String(run.next_send_at).replace(' ', 'T')) || '') : '';
                val.innerHTML = `<span style="color:var(--accent-warning,#f59e0b);font-weight:600;">Lembrete ${(+run.step_idx || 0) + 1}</span>`
                    + (prox ? `<span style="color:var(--text-muted);font-weight:400;"> · próximo ${escapeHtml(prox)}</span>` : '')
                    + ` <button onclick="lppStopFollowup('${leadId}')" style="margin-left:0.4rem;font-size:0.7rem;padding:1px 7px;border-radius:5px;border:1px solid var(--border-color);background:transparent;color:var(--text-muted);cursor:pointer;">Parar</button>`;
                row.style.display = '';
            }
        } catch (_) { /* silencioso */ }
    })();

    // Último atendente humano que respondeu pelo WhatsApp (async).
    (async () => {
        const valEl = document.getElementById('lpp-last-agent-value');
        if (!valEl) return;
        try {
            const r = await fetch(`/api/leads/${leadId}/ultimo-atendente`).then(x => x.json());
            if (r && r.atendente) {
                const raw = r.quando ? String(r.quando).replace(' ', 'T') : '';
                const rel = raw ? (lppRelativeTime(raw) || lppFormatDate(raw)) : '';
                const quando = rel ? ` · ${rel}` : '';
                valEl.innerHTML = `${escapeHtml(r.atendente)}<span style="color:var(--text-muted);font-weight:400;">${quando}</span>`;
            } else if (r && r.via_ia) {
                valEl.innerHTML = `<span style="color:var(--text-muted);">Agente de IA</span>`;
            } else {
                const row = document.getElementById('lpp-last-agent-row');
                if (row) row.style.display = 'none';
            }
        } catch (_) {
            const row = document.getElementById('lpp-last-agent-row');
            if (row) row.style.display = 'none';
        }
    })();

    // Notas — em card, com prévia resumida e "Ver mais" quando o texto é longo.
    const notasSection = document.getElementById('lpp-notas-section');
    const notasEl = document.getElementById('lpp-notas');
    const notasToggle = document.getElementById('lpp-notas-toggle');
    if (lead.notas && lead.notas.trim()) {
        notasEl.textContent = lead.notas.trim();
        notasEl.classList.remove('is-clamped');
        notasSection.style.display = '';
        requestAnimationFrame(() => {
            const overflowing = notasEl.scrollHeight > 150;
            if (overflowing) notasEl.classList.add('is-clamped');
            if (notasToggle) {
                notasToggle.hidden = !overflowing;
                notasToggle.textContent = 'Ver mais';
            }
        });
    } else {
        notasSection.style.display = 'none';
    }

    // Abas: sempre começa em "Orçamentos" ao abrir a ficha.
    lppSwitchTab('orc');

    // Orçamentos
    const orcEl = document.getElementById('lpp-orcamentos');
    const orcamentos = lppParseOrcamento(lead.orcamento);
    if (orcamentos.length) {
        const total = orcamentos.reduce((s, o) => s + (parseFloat(o.valor) || 0), 0);
        orcEl.innerHTML = orcamentos.map(o => `
            <div class="lpp-orc-item">
                <div style="display:flex;flex-direction:column;gap:0.15rem;">
                    <span class="lpp-orc-proc">${o.procedimento || '—'}</span>
                    ${o.created_at ? `<span style="font-size:0.72rem;color:var(--text-muted);">${lppFormatDateTime(o.created_at)}</span>` : ''}
                </div>
                <span class="lpp-orc-valor">${lppFormatMoney(o.valor)}</span>
            </div>
        `).join('') + (orcamentos.length > 1 ? `<div class="lpp-orc-total"><span>Total</span><span>${lppFormatMoney(total)}</span></div>` : '');
    } else {
        orcEl.innerHTML = '<span class="lpp-empty">Nenhum orçamento registrado.</span>';
    }

    // Histórico de agendamentos (async)
    const histEl = document.getElementById('lpp-historico');
    histEl.innerHTML = `<span class="amicro-loader"><span></span><span></span><span></span></span>`;

    try {
        const agendamentos = await fetch(`/api/leads/${leadId}/agendamentos`).then(r => r.json());
        if (agendamentos && agendamentos.length) {
            histEl.innerHTML = agendamentos.map(a => {
                const valor = a.valor_primario || a.valor_secundario;
                const data = a.data_agendamento ? new Date(a.data_agendamento).toLocaleDateString('pt-BR') : '—';
                return `
                <div class="lpp-hist-item">
                    <div class="lpp-hist-icon"><i class="fa-solid fa-check"></i></div>
                    <div class="lpp-hist-info">
                        <div class="lpp-hist-proc">${a.procedimento || '—'}</div>
                        <div class="lpp-hist-meta">${data}${a.status_pagamento ? ' · ' + a.status_pagamento : ''}${a.unidade ? ' · ' + a.unidade : ''}</div>
                    </div>
                    ${valor ? `<div class="lpp-hist-valor">${valor}</div>` : ''}
                </div>`;
            }).join('');
        } else {
            histEl.innerHTML = '<span class="lpp-empty">Nenhum agendamento registrado.</span>';
        }
    } catch (_) {
        histEl.innerHTML = '<span class="lpp-empty">Erro ao carregar histórico.</span>';
    }

    // Abre como página dedicada (ocupa a tela toda).
    if (overlay) overlay.style.display = 'none';
    panel.classList.add('active');
    const body = panel.querySelector('.lpp-body');
    if (body) body.scrollTop = 0;
}

function closeLeadProfile() {
    const panel = document.getElementById('lead-profile-panel');
    const overlay = document.getElementById('lead-profile-overlay');
    if (panel) panel.classList.remove('active');
    if (overlay) overlay.style.display = 'none';
}

// Esc fecha a ficha do lead — a menos que haja um modal aberto por cima
// (nesse caso o modal fecha primeiro).
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const panel = document.getElementById('lead-profile-panel');
    if (!panel || !panel.classList.contains('active')) return;
    if (document.querySelector('.modal-overlay.active, .custom-modal-overlay')) return;
    closeLeadProfile();
});

// Alterna entre as abas "Orçamentos" e "Histórico de agendamentos" na ficha do lead.
function lppSwitchTab(name) {
    const tabs = { orc: 'lpp-tab-orc', hist: 'lpp-tab-hist' };
    const panels = { orc: 'lpp-panel-orc', hist: 'lpp-panel-hist' };
    Object.keys(tabs).forEach(key => {
        const tabEl = document.getElementById(tabs[key]);
        const panelEl = document.getElementById(panels[key]);
        const active = key === name;
        if (tabEl) {
            tabEl.classList.toggle('is-active', active);
            tabEl.setAttribute('aria-selected', active ? 'true' : 'false');
        }
        if (panelEl) panelEl.hidden = !active;
    });
}

// === SIDEBAR: rail fixo que expande ao passar o mouse ===
// A barra fica sempre recolhida (só ícones) e abre no :hover via CSS.
document.addEventListener('DOMContentLoaded', () => {
    const header = document.querySelector('header');
    if (header && header.querySelector('.sb-nav')) {
        header.classList.add('sb-collapsed');
    }
});

// Mantido como no-op para não quebrar chamadas antigas.
function toggleSidebar() {}

/* ============================================================================
   INTEGRAÇÃO DE AGENDAMENTO — redesign premium (fonte única).
   Reescreve só a APRESENTAÇÃO do modal #modalAgendamento em todas as páginas.
   Todos os ids, o fluxo e a lógica de envio (confirmAgendamento / /api/agendar)
   são preservados. Valores continuam sendo enviados normalizados ("380.00");
   a máscara "R$ 0,00" é apenas visual.
   ========================================================================== */
(function () {
    if (window.__agxAgendamentoWired) return;
    window.__agxAgendamentoWired = true;

    var pad2 = function (n) { return String(n).padStart(2, '0'); };

    function fmtDateBR(v) {
        if (!v) return '';
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).split('T')[0]);
        return m ? (m[3] + '/' + m[2] + '/' + m[1]) : v;
    }
    function brl(n) {
        return Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    }
    function toNumber(s) {
        var n = parseFloat(String(s == null ? '' : s).replace(/\s/g, '').replace(',', '.'));
        return isFinite(n) ? n : 0;
    }

    /* -------- template do modal (mantém todos os ids originais) -------- */
    function template(snap) {
        return [
'<form id="form-agendar" class="agx-form" novalidate>',
'  <input type="hidden" id="ag-lead-id">',
'  <div class="agx-head">',
'    <div class="agx-head-main">',
'      <span class="agx-head-icon"><i class="fa-regular fa-calendar-check"></i></span>',
'      <div><h2>Novo agendamento</h2></div>',
'    </div>',
'  </div>',
'  <div class="agx-body">',

'    <div class="agx-col agx-col--left">',

'    <section class="agx-section">',
'      <div class="agx-section-head"><i class="fa-regular fa-user"></i><div>',
'        <h3>Dados do paciente</h3><p>Busque um paciente já cadastrado ou registre um novo.</p></div></div>',
'      <div class="agx-kanban-note" id="agx-kanban-note" style="display:none;">',
'        <i class="fa-solid fa-circle-info"></i>',
'        <span>Este agendamento usa o paciente do card do funil. Os dados de contato são enviados automaticamente ao Amigo App.</span>',
'      </div>',
'      <div id="directScheduleFields">',
'        <div class="agx-field full agx-hasicon" style="position:relative;">',
'          <label for="ag-patient-name">Buscar paciente</label>',
'          <i class="fa-solid fa-magnifying-glass"></i>',
'          <input type="text" id="ag-patient-name" placeholder="Buscar por nome ou telefone..." autocomplete="off" oninput="buscarPacienteExistente(this.value)">',
'          <div id="ag-patient-dropdown" style="display:none;"></div>',
'          <div class="agx-err">Informe o nome do paciente.</div>',
'        </div>',
'        <div class="agx-row" style="margin-top:.85rem;">',
'          <div class="agx-field"><label for="ag-patient-phone">Telefone (WhatsApp)</label>',
'            <input type="text" id="ag-patient-phone" placeholder="(61) 99999-9999"></div>',
'          <div class="agx-field"><label for="ag-patient-born">Data de nascimento</label>',
'            <input type="date" id="ag-patient-born"></div>',
'        </div>',
'        <div class="agx-row" style="margin-top:.85rem;">',
'          <div class="agx-field full"><label for="ag-patient-email">E-mail</label>',
'            <input type="email" id="ag-patient-email" placeholder="email@exemplo.com"></div>',
'        </div>',
'      </div>',
'    </section>',

'    <section class="agx-section">',
'      <div class="agx-section-head"><i class="fa-solid fa-receipt"></i><div>',
'        <h3>Informações comerciais</h3><p>Valores e classificação usados na planilha de gestão.</p></div></div>',
'      <div class="agx-row">',
'        <div class="agx-field"><label for="ag-valor1-mask">Valor principal</label>',
'          <input type="text" id="ag-valor1-mask" inputmode="numeric" placeholder="R$ 0,00" data-target="ag-valor1">',
'          <input type="hidden" id="ag-valor1"></div>',
'        <div class="agx-field"><label for="ag-valor2-mask">Valor adicional</label>',
'          <input type="text" id="ag-valor2-mask" inputmode="numeric" placeholder="R$ 0,00" data-target="ag-valor2">',
'          <input type="hidden" id="ag-valor2"></div>',
'      </div>',
'      <div class="agx-row" style="margin-top:.85rem;">',
'        <div class="agx-field agx-sel"><label for="ag-status-pag">Status</label>',
'          <select id="ag-status-pag" required>' + snap.status + '</select></div>',
'        <div class="agx-field agx-sel"><label for="ag-origem">Origem</label>',
'          <select id="ag-origem" required>' + snap.origem + '</select></div>',
'      </div>',
'    </section>',

'    </div>',

'    <div class="agx-col agx-col--right">',

'    <section class="agx-section">',
'      <div class="agx-section-head"><i class="fa-regular fa-calendar"></i><div>',
'        <h3>Dados do agendamento</h3><p>Clínica, profissional, procedimento e o melhor horário.</p></div></div>',
'      <div class="agx-row">',
'        <div class="agx-field agx-sel"><label for="ag-place">Clínica</label>',
'          <select id="ag-place" required>' + snap.place + '</select>',
'          <div class="agx-err">Selecione a clínica.</div></div>',
'        <div class="agx-field agx-sel"><label for="ag-user">Profissional</label>',
'          <select id="ag-user" required>' + snap.user + '</select>',
'          <div class="agx-err">Selecione o profissional.</div></div>',
'      </div>',
'      <div class="agx-field full agx-hasicon" style="position:relative; margin-top:.85rem;">',
'        <label for="ag-event-search">Procedimento ou serviço</label>',
'        <i class="fa-solid fa-magnifying-glass"></i>',
'        <input type="text" id="ag-event-search" placeholder="Buscar procedimento..." autocomplete="off">',
'        <input type="hidden" id="ag-event" required>',
'        <div id="ag-event-dropdown" style="display:none;">' + snap.event + '</div>',
'        <div class="agx-proc-hint" id="agx-proc-hint"><i class="fa-solid fa-tag"></i> Valor sugerido: <b>—</b></div>',
'        <div class="agx-err">Escolha o procedimento.</div>',
'      </div>',
'      <div class="agx-field full" style="margin-top:.85rem;">',
'        <label>Data e horário</label>',
'        <div class="agx-datetime">',
'          <div class="agx-field"><label for="ag-data">Data</label><input type="date" id="ag-data" required></div>',
'          <div class="agx-field"><label for="ag-hora">Horário</label><input type="time" id="ag-hora" required></div>',
'        </div>',
'        <div class="agx-err">Informe data e horário.</div>',
'      </div>',
'      <div class="agx-sched">',
'        <div class="agx-sched-row">',
'          <h4><i class="fa-solid fa-wand-magic-sparkles" style="color:var(--accent-primary);margin-right:.35rem;"></i>Sugestões de agenda</h4>',
'          <div id="sugestao-loader" style="display:none;"><span class="amicro-loader"><span></span><span></span><span></span></span></div>',
'        </div>',
'        <div id="sugestoes-dias"></div>',
'        <div class="agx-slots-label">Horários disponíveis</div>',
'        <div id="sugestoes-horas" style="display:none;"></div>',
'      </div>',
'    </section>',

'    <div class="agx-resumo">',
'      <h3><i class="fa-regular fa-rectangle-list"></i> Resumo do agendamento</h3>',
'      <dl>',
'        <dt>Paciente</dt><dd id="ag-res-paciente" class="is-empty">—</dd>',
'        <dt>Procedimento</dt><dd id="ag-res-procedimento" class="is-empty">—</dd>',
'        <dt>Profissional</dt><dd id="ag-res-profissional" class="is-empty">—</dd>',
'        <dt>Clínica</dt><dd id="ag-res-clinica" class="is-empty">—</dd>',
'        <dt>Data</dt><dd id="ag-res-data" class="is-empty">—</dd>',
'        <dt>Horário</dt><dd id="ag-res-horario" class="is-empty">—</dd>',
'        <dt>Valor</dt><dd id="ag-res-valor" class="is-empty agx-valor">—</dd>',
'      </dl>',
'    </div>',

'    </div>',
'  </div>',
'</form>',
'<div class="modal-actions agx-footer" id="integrationActions">',
'  <div class="integration-loader" id="integrationLoader"><span class="amicro-loader"><span></span><span></span><span></span></span> Enviando para o Amigo App…</div>',
'  <button type="button" class="btn-cancel" onclick="cancelAgendamento()">Cancelar</button>',
'  <button type="button" class="btn-save" onclick="confirmAgendamento()">Enviar para o Amigo App →</button>',
'</div>'
        ].join('\n');
    }

    function snapshot() {
        var g = function (id, fb) {
            var el = document.getElementById(id);
            return el && el.innerHTML.trim() ? el.innerHTML : fb;
        };
        return {
            place: g('ag-place', '<option value="">Selecione...</option>'),
            user: g('ag-user', '<option value="">Selecione...</option>'),
            event: g('ag-event-dropdown', ''),
            status: g('ag-status-pag', '<option value="Pendente">Pendente</option><option value="Pago">Pago</option><option value="50%">50%</option>'),
            origem: g('ag-origem', '<option value="Orgânico">Orgânico</option><option value="Tráfego">Tráfego</option><option value="Indicação">Indicação</option>')
        };
    }

    /* -------- resumo ao vivo -------- */
    function setRes(id, val) {
        var el = document.getElementById(id);
        if (!el) return;
        var v = (val || '').toString().trim();
        if (v) {
            if (el.textContent !== v) {
                el.textContent = v;
                el.classList.add('agx-flash');
                setTimeout(function () { el.classList.remove('agx-flash'); }, 260);
            }
            el.classList.remove('is-empty');
        } else {
            el.textContent = '—';
            el.classList.add('is-empty');
        }
    }
    function updateResumo() {
        var selTxt = function (id) {
            var s = document.getElementById(id);
            return s && s.selectedIndex > 0 ? s.options[s.selectedIndex].text : '';
        };
        var nome = (document.getElementById('ag-patient-name') || {}).value || '';
        if (!nome && window.draggedLead) nome = window.draggedLead.nome || '';
        setRes('ag-res-paciente', nome);
        setRes('ag-res-procedimento', (document.getElementById('ag-event-search') || {}).value || '');
        setRes('ag-res-profissional', selTxt('ag-user'));
        setRes('ag-res-clinica', selTxt('ag-place'));
        setRes('ag-res-data', fmtDateBR((document.getElementById('ag-data') || {}).value || ''));
        setRes('ag-res-horario', (document.getElementById('ag-hora') || {}).value || '');
        var v1 = toNumber((document.getElementById('ag-valor1') || {}).value);
        var v2 = toNumber((document.getElementById('ag-valor2') || {}).value);
        var valor = '';
        if (v1 > 0) valor = brl(v1);
        if (v2 > 0) valor = (valor ? valor + '   +   ' : '') + brl(v2);
        setRes('ag-res-valor', valor);
    }

    /* -------- máscara monetária (apenas visual) -------- */
    function maskCurrency(e) {
        var el = e.target;
        var hid = document.getElementById(el.dataset.target);
        var digits = el.value.replace(/\D/g, '');
        if (!digits) { el.value = ''; if (hid) hid.value = ''; updateResumo(); return; }
        var val = parseInt(digits, 10) / 100;
        el.value = brl(val);
        if (hid) hid.value = val.toFixed(2);
        updateResumo();
    }
    function syncCurrencyDisplay() {
        [['ag-valor1-mask', 'ag-valor1'], ['ag-valor2-mask', 'ag-valor2']].forEach(function (p) {
            var m = document.getElementById(p[0]), h = document.getElementById(p[1]);
            if (!m || !h) return;
            var v = toNumber(h.value);
            m.value = v > 0 ? brl(v) : '';
        });
    }

    /* -------- valor sugerido do procedimento (só se a API fornecer) -------- */
    function updateProcHint() {
        var hint = document.getElementById('agx-proc-hint');
        if (!hint) return;
        var id = (document.getElementById('ag-event') || {}).value;
        var price = null;
        if (id && window.apiOptions && Array.isArray(apiOptions.events)) {
            var ev = apiOptions.events.find(function (x) { return String(x.id) === String(id); });
            if (ev) price = ev.price != null ? ev.price
                : ev.valor != null ? ev.valor
                : ev.value != null ? ev.value
                : ev.default_value != null ? ev.default_value : null;
        }
        if (price != null && toNumber(price) > 0) {
            hint.querySelector('b').textContent = brl(toNumber(price));
            hint.classList.add('show');
        } else {
            hint.classList.remove('show');
        }
    }

    /* -------- validação inline (sem popup) -------- */
    function fieldOf(id) {
        var el = document.getElementById(id);
        return el ? el.closest('.agx-field') : null;
    }
    function mark(fEl, bad) {
        if (fEl) fEl.classList.toggle('is-invalid', !!bad);
    }
    function validate() {
        var ok = true, first = null;
        var checks = [
            ['ag-place', 'ag-place'],
            ['ag-user', 'ag-user'],
            ['ag-event', 'ag-event-search'],
            ['ag-data', 'ag-data'],
            ['ag-hora', 'ag-hora']
        ];
        checks.forEach(function (c) {
            var ctl = document.getElementById(c[0]);
            var fEl = fieldOf(c[1]);
            var bad = !ctl || !ctl.value;
            mark(fEl, bad);
            if (bad) { ok = false; first = first || fEl; }
        });
        var dsf = document.getElementById('directScheduleFields');
        if (dsf && dsf.style.display !== 'none') {
            var n = document.getElementById('ag-patient-name');
            var bad = !n || !n.value.trim();
            var fEl = fieldOf('ag-patient-name');
            mark(fEl, bad);
            if (bad) { ok = false; first = first || fEl; }
        }
        if (first) {
            var inp = first.querySelector('input, select');
            if (inp) { try { inp.focus({ preventScroll: true }); } catch (e) { inp.focus(); } }
            first.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
        return ok;
    }

    /* -------- abertura do modal -------- */
    function onOpen() {
        syncCurrencyDisplay();
        document.querySelectorAll('#modalAgendamento .agx-field.is-invalid')
            .forEach(function (f) { f.classList.remove('is-invalid'); });
        var btn = document.querySelector('#integrationActions .btn-save');
        if (btn) { btn.disabled = false; btn.classList.remove('agx-ok'); }
        var dsf = document.getElementById('directScheduleFields');
        var note = document.getElementById('agx-kanban-note');
        if (note) note.style.display = (dsf && dsf.style.display === 'none') ? 'flex' : 'none';
        updateProcHint();
        updateResumo();
    }

    /* -------- fiação de listeners -------- */
    function wire() {
        var form = document.getElementById('form-agendar');
        if (!form) return;

        ['ag-valor1-mask', 'ag-valor2-mask'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.addEventListener('input', maskCurrency);
        });

        ['ag-patient-name', 'ag-event-search', 'ag-user', 'ag-place', 'ag-data', 'ag-hora'].forEach(function (id) {
            var el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('input', updateResumo);
            el.addEventListener('change', updateResumo);
        });

        var agUser = document.getElementById('ag-user');
        var agData = document.getElementById('ag-data');
        if (agUser) agUser.addEventListener('change', function () { if (typeof window.loadTimeSuggestions === 'function') window.loadTimeSuggestions(); });
        if (agData) agData.addEventListener('change', function () { if (typeof window.loadTimeSuggestions === 'function') window.loadTimeSuggestions(); });

        var evDrop = document.getElementById('ag-event-dropdown');
        if (evDrop) evDrop.addEventListener('click', function () {
            setTimeout(function () { updateProcHint(); updateResumo(); }, 0);
        });

        ['sugestoes-dias', 'sugestoes-horas'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.addEventListener('click', function () { setTimeout(updateResumo, 0); });
        });

        // limpa o estado de erro do campo assim que o usuário mexe nele
        form.addEventListener('input', function (e) {
            var f = e.target.closest && e.target.closest('.agx-field.is-invalid');
            if (f) f.classList.remove('is-invalid');
        });
        form.addEventListener('change', function (e) {
            var f = e.target.closest && e.target.closest('.agx-field.is-invalid');
            if (f) f.classList.remove('is-invalid');
        });
    }

    /* -------- monta o modal uma vez -------- */
    function build() {
        var overlay = document.getElementById('modalAgendamento');
        if (!overlay || overlay.dataset.agxBuilt) return;
        var modal = overlay.querySelector('.modal');
        if (!modal) return;

        var snap = snapshot();
        modal.classList.add('agx-modal');
        modal.innerHTML = template(snap);
        overlay.dataset.agxBuilt = '1';

        // Se as opções da API ainda não foram carregadas, popula quando chegarem.
        if (typeof populateSelects === 'function' &&
            window.apiOptions && apiOptions.places && apiOptions.places.length &&
            document.getElementById('ag-place') &&
            document.getElementById('ag-place').options.length <= 1) {
            try { populateSelects(); } catch (e) { /* noop */ }
        }

        // Recria o datepicker estilizado nos novos inputs de data.
        if (typeof window._initAirDatepicker === 'function') {
            try { window._initAirDatepicker(); } catch (e) { /* noop */ }
        }

        wire();

        var lastActive = overlay.classList.contains('active');
        new MutationObserver(function () {
            var active = overlay.classList.contains('active');
            if (active && !lastActive) setTimeout(onOpen, 0);
            lastActive = active;
        }).observe(overlay, { attributes: true, attributeFilter: ['class'] });

        if (lastActive) setTimeout(onOpen, 0);
    }

    /* -------- wrapper: estado de "Enviando…" + validação inline -------- */
    function wrapConfirm() {
        if (typeof window.confirmAgendamento !== 'function' || window.confirmAgendamento.__agxWrapped) return;
        var original = window.confirmAgendamento;
        var wrapped = async function () {
            if (!validate()) return;
            var overlay = document.getElementById('modalAgendamento');
            var btn = document.querySelector('#integrationActions .btn-save');
            var prev = btn ? btn.innerHTML : '';
            if (btn) {
                btn.disabled = true;
                btn.classList.remove('agx-ok');
                btn.innerHTML = '<span class="amicro-loader"><span></span><span></span><span></span></span> Enviando...';
            }
            try {
                return await original.apply(this, arguments);
            } finally {
                if (btn) {
                    var stillOpen = overlay && overlay.classList.contains('active');
                    if (stillOpen) {
                        btn.disabled = false;
                        btn.innerHTML = prev;
                    } else {
                        btn.classList.add('agx-ok');
                        btn.disabled = true;
                        btn.innerHTML = '<i class="fa-solid fa-check"></i> Agendamento enviado';
                        setTimeout(function () {
                            btn.classList.remove('agx-ok');
                            btn.disabled = false;
                            btn.innerHTML = prev || 'Enviar para o Amigo App →';
                        }, 1900);
                    }
                }
            }
        };
        wrapped.__agxWrapped = true;
        window.confirmAgendamento = wrapped;
    }

    /* -------- wrapper: grade de horários com estado "indisponível" -------- */
    function wrapLoadTimes() {
        if (typeof window.loadTimeSuggestions !== 'function' || window.loadTimeSuggestions.__agxWrapped) return;
        var original = window.loadTimeSuggestions;
        var wrapped = async function () {
            var r = await original.apply(this, arguments);
            try {
                var c = document.getElementById('sugestoes-horas');
                if (c && c.style.display !== 'none') {
                    var live = [].slice.call(c.querySelectorAll('.suggestion-chip:not(.agx-slot-off)'));
                    var have = {};
                    live.forEach(function (x) { have[x.textContent.trim()] = 1; });
                    if (live.length) {
                        for (var h = 8; h <= 19; h++) {
                            ['00', '30'].forEach(function (mm) {
                                var t = pad2(h) + ':' + mm;
                                if (!have[t]) {
                                    var el = document.createElement('div');
                                    el.className = 'suggestion-chip agx-slot-off';
                                    el.textContent = t;
                                    el.title = 'Indisponível';
                                    c.appendChild(el);
                                }
                            });
                        }
                        [].slice.call(c.querySelectorAll('.suggestion-chip'))
                            .sort(function (a, b) { return a.textContent.trim().localeCompare(b.textContent.trim()); })
                            .forEach(function (n) { c.appendChild(n); });
                    }
                }
            } catch (e) { /* noop */ }
            updateResumo();
            return r;
        };
        wrapped.__agxWrapped = true;
        window.loadTimeSuggestions = wrapped;
    }

    function boot() {
        build();
        wrapConfirm();
        wrapLoadTimes();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();

// ============================================================================
// BIBLIOTECA DE MÍDIA — gerenciador de arquivos p/ enviar mídia aos leads
// Armazenamento: base64 no D1 (mesmo padrão da crm_voice_library).
// ============================================================================
let midxFolder = null;                 // pasta atual (null = raiz)
let midxData = { folders: [], items: [], breadcrumb: [] };
let midxSendCtx = null;                 // { id, nome, tipo, legenda }
let midxSendLead = null;                // { id, nome, telefone }
let midxLibFolder = null;
let midxLibData = { folders: [], items: [], breadcrumb: [] };

async function loadMidias(folder) {
    if (folder !== undefined) midxFolder = folder;
    const grid = document.getElementById('midx-grid');
    if (grid) grid.innerHTML = '<div class="midx-empty"><span class="amicro-loader"><span></span><span></span><span></span></span></div>';
    try {
        const res = await fetch('/api/media' + (midxFolder ? ('?folder=' + encodeURIComponent(midxFolder)) : ''));
        midxData = await res.json();
    } catch (e) { midxData = { folders: [], items: [], breadcrumb: [] }; }
    renderMidias();
}

function midxCrumbHtml(data) {
    const parts = ['<a href="#" onclick="loadMidias(null); return false;">Mídias</a>'];
    (data.breadcrumb || []).forEach(function (b) { parts.push('<span>/</span><b>' + escapeHtml(b.nome) + '</b>'); });
    return parts.join(' ');
}

function renderMidias() {
    const crumb = document.getElementById('midx-crumb');
    if (crumb) crumb.innerHTML = midxCrumbHtml(midxData);
    const grid = document.getElementById('midx-grid');
    if (!grid) return;
    const q = (document.getElementById('midx-search') && document.getElementById('midx-search').value || '').trim().toLowerCase();
    const folders = (midxData.folders || []).filter(function (f) { return !q || (f.nome || '').toLowerCase().includes(q); });
    const items = (midxData.items || []).filter(function (i) { return !q || (i.nome || '').toLowerCase().includes(q); });

    if (!folders.length && !items.length) {
        grid.innerHTML = '<div class="midx-empty"><i class="fa-solid fa-folder-open"></i><span>' +
            (q ? 'Nada encontrado.' : 'Pasta vazia. Arraste um arquivo aqui, ou use "Enviar arquivo".') + '</span></div>';
        return;
    }

    const folderHtml = folders.map(function (f) {
        const nmeta = JSON.stringify(String(f.nome)).replace(/"/g, '&quot;');
        return '<div class="midx-tile midx-tile--folder" ondblclick="loadMidias(\'' + f.id + '\')"' +
            ' oncontextmenu="midxOnFolderCtx(event, \'' + f.id + '\', ' + nmeta + ')"' +
            ' ondragover="event.preventDefault(); this.classList.add(\'is-dragover\');"' +
            ' ondragleave="this.classList.remove(\'is-dragover\');"' +
            ' ondrop="this.classList.remove(\'is-dragover\'); midxMoveDropped(event, \'' + f.id + '\')">' +
            '<div class="midx-tile-actions">' +
            '<button title="Renomear" onclick="event.stopPropagation(); midxRename(\'folder\',\'' + f.id + '\', ' + nmeta + ')"><i class="fa-solid fa-pen"></i></button>' +
            '<button class="is-danger" title="Excluir" onclick="event.stopPropagation(); midxDelete(\'folder\',\'' + f.id + '\')"><i class="fa-solid fa-trash"></i></button>' +
            '</div>' +
            '<i class="fa-solid fa-folder midx-tile-ic"></i>' +
            '<span class="midx-tile-name">' + escapeHtml(f.nome) + '</span>' +
            '</div>';
    }).join('');

    const itemHtml = items.map(function (i) {
        const nmeta = JSON.stringify(String(i.nome)).replace(/"/g, '&quot;');
        const thumb = i.tipo === 'image'
            ? '<img class="midx-tile-thumb" loading="lazy" src="' + (i.thumb_base64 ? ('data:image/jpeg;base64,' + i.thumb_base64) : ('/api/media/' + i.id + '/raw')) + '" alt="">'
            : '<i class="fa-solid ' + (i.tipo === 'video' ? 'fa-film' : i.tipo === 'audio' ? 'fa-music' : 'fa-file-lines') + ' midx-tile-ic"></i>';
        return '<div class="midx-tile" draggable="true"' +
            ' ondragstart="event.dataTransfer.setData(\'text/midx\',\'' + i.id + '\')"' +
            ' oncontextmenu="midxOnItemCtx(event, \'' + i.id + '\')"' +
            ' ondblclick="midxPreview(\'' + i.id + '\')">' +
            '<div class="midx-tile-actions">' +
            '<button title="Renomear" onclick="event.stopPropagation(); midxRename(\'item\',\'' + i.id + '\', ' + nmeta + ')"><i class="fa-solid fa-pen"></i></button>' +
            '<button class="is-danger" title="Excluir" onclick="event.stopPropagation(); midxDelete(\'item\',\'' + i.id + '\')"><i class="fa-solid fa-trash"></i></button>' +
            '</div>' +
            thumb +
            '<span class="midx-tile-name">' + escapeHtml(i.nome) + '</span>' +
            '<button class="midx-tile-send" onclick="event.stopPropagation(); midxOpenSend(\'' + i.id + '\')"><i class="fa-brands fa-whatsapp"></i> Enviar</button>' +
            '</div>';
    }).join('');

    grid.innerHTML = folderHtml + itemHtml;
}

async function midxNewFolder() {
    const nome = await customPrompt('Nome da pasta:', '', 'Nova pasta');
    if (!nome || !nome.trim()) return;
    try {
        await fetch('/api/media/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome: nome.trim(), parent_id: midxFolder }) });
        loadMidias();
    } catch (e) { showToast('Erro ao criar a pasta.', 'danger'); }
}

async function midxRename(kind, id, currentName) {
    const nome = await customPrompt('Novo nome:', currentName || '', 'Renomear');
    if (nome == null || !nome.trim()) return;
    const url = kind === 'folder' ? ('/api/media/folders/' + id) : ('/api/media/' + id);
    try {
        await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nome: nome.trim() }) });
        loadMidias();
    } catch (e) { showToast('Erro ao renomear.', 'danger'); }
}

async function midxDelete(kind, id) {
    const msg = kind === 'folder'
        ? 'Excluir a pasta? Os arquivos de dentro voltam para a raiz.'
        : 'Excluir este arquivo da biblioteca?';
    if (!await customConfirm(msg, 'Excluir')) return;
    const url = kind === 'folder' ? ('/api/media/folders/' + id) : ('/api/media/' + id);
    try { await fetch(url, { method: 'DELETE' }); loadMidias(); }
    catch (e) { showToast('Erro ao excluir.', 'danger'); }
}

// ---- menu de contexto (botão direito) — reaproveita as classes .card-ctx (tokens de tema) ----
function midxCtxEl() {
    let el = document.getElementById('midx-ctx-menu');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'midx-ctx-menu';
    el.className = 'card-ctx';
    el.style.display = 'none';
    document.body.appendChild(el);
    document.addEventListener('click', midxCloseCtx);
    document.addEventListener('contextmenu', function (e) {
        if (!e.target.closest('#midx-grid') && !e.target.closest('#midx-ctx-menu')) midxCloseCtx();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') midxCloseCtx(); });
    window.addEventListener('resize', midxCloseCtx);
    window.addEventListener('scroll', midxCloseCtx, true);
    return el;
}
function midxCloseCtx() {
    const el = document.getElementById('midx-ctx-menu');
    if (el) el.style.display = 'none';
}
function midxShowCtx(items, x, y) {
    const el = midxCtxEl();
    const main = document.createElement('div');
    main.className = 'card-ctx-main';
    items.forEach(function (it) {
        if (it.sep) {
            const s = document.createElement('div');
            s.className = 'card-ctx-sep';
            main.appendChild(s);
            return;
        }
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'card-ctx-item' + (it.danger ? ' card-ctx-item--danger' : '');
        if (it.disabled) b.disabled = true;
        b.innerHTML = '<i class="' + it.icon + '"></i> <span>' + escapeHtml(it.label) + '</span>';
        b.addEventListener('click', function (ev) {
            ev.stopPropagation();
            midxCloseCtx();
            if (typeof it.fn === 'function') it.fn();
        });
        main.appendChild(b);
    });
    el.innerHTML = '';
    el.appendChild(main);
    el.style.display = 'block';
    const r = el.getBoundingClientRect();
    let left = x, top = y;
    if (left + r.width > window.innerWidth - 8) left = window.innerWidth - r.width - 8;
    if (top + r.height > window.innerHeight - 8) top = window.innerHeight - r.height - 8;
    el.style.left = Math.max(8, left) + 'px';
    el.style.top = Math.max(8, top) + 'px';
}
function midxOnFolderCtx(event, id, name) {
    event.preventDefault();
    event.stopPropagation();
    midxShowCtx([
        { icon: 'fa-solid fa-folder-open', label: 'Abrir', fn: function () { loadMidias(id); } },
        { icon: 'fa-solid fa-pen', label: 'Renomear', fn: function () { midxRename('folder', id, name); } },
        { sep: true },
        { icon: 'fa-solid fa-trash', label: 'Excluir pasta', danger: true, fn: function () { midxDelete('folder', id); } }
    ], event.clientX, event.clientY);
}
function midxOnItemCtx(event, id) {
    event.preventDefault();
    event.stopPropagation();
    const it = (midxData.items || []).find(function (x) { return x.id === id; });
    const name = it ? it.nome : '';
    midxShowCtx([
        { icon: 'fa-brands fa-whatsapp', label: 'Enviar para lead', fn: function () { midxOpenSend(id); } },
        { icon: 'fa-solid fa-eye', label: 'Pré-visualizar', fn: function () { midxPreview(id); } },
        { icon: 'fa-solid fa-pen', label: 'Renomear', fn: function () { midxRename('item', id, name); } },
        { sep: true },
        { icon: 'fa-solid fa-trash', label: 'Excluir', danger: true, fn: function () { midxDelete('item', id); } }
    ], event.clientX, event.clientY);
}
function midxOnGridCtx(event) {
    if (event.target.closest('.midx-tile')) return; // tile tem o seu próprio menu
    event.preventDefault();
    midxShowCtx([
        { icon: 'fa-solid fa-folder-plus', label: 'Nova pasta', fn: midxNewFolder },
        { icon: 'fa-solid fa-arrow-up-from-bracket', label: 'Enviar arquivo', fn: function () {
            const i = document.getElementById('midx-file-input');
            if (i) i.click();
        } },
        { sep: true },
        { icon: 'fa-solid fa-rotate', label: 'Atualizar', fn: function () { loadMidias(); } }
    ], event.clientX, event.clientY);
}

// ---- upload ----
function midxReadAsDataURL(file) {
    return new Promise(function (resolve, reject) {
        const r = new FileReader();
        r.onload = function () { resolve(r.result); };
        r.onerror = reject;
        r.readAsDataURL(file);
    });
}
function midxCompressImage(file, maxDim, quality) {
    return new Promise(function (resolve, reject) {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = function () {
            let w = img.naturalWidth, h = img.naturalHeight;
            if (Math.max(w, h) > maxDim) { const s = maxDim / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            c.getContext('2d').drawImage(img, 0, 0, w, h);
            URL.revokeObjectURL(url);
            resolve(c.toDataURL('image/jpeg', quality));
        };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('img')); };
        img.src = url;
    });
}
async function midxUploadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    let ok = 0;
    for (const file of files) {
        try {
            const isImg = file.type.startsWith('image/');
            const data = isImg ? await midxCompressImage(file, 1600, 0.82) : await midxReadAsDataURL(file);
            const thumb = isImg ? (await midxCompressImage(file, 240, 0.7)).split(',')[1] : null;
            const res = await fetch('/api/media', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nome: file.name, data: data, thumb: thumb, folder_id: midxFolder })
            });
            const j = await res.json().catch(function () { return {}; });
            if (res.ok) ok++; else showToast(j.error || ('Falha em ' + file.name), 'danger');
        } catch (e) { showToast('Erro ao processar ' + file.name, 'danger'); }
    }
    if (ok) showToast(ok === 1 ? 'Arquivo adicionado.' : (ok + ' arquivos adicionados.'), 'success');
    loadMidias();
}
function midxDrop(e) {
    e.preventDefault();
    const grid = document.getElementById('midx-grid');
    if (grid) grid.classList.remove('is-drop');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) midxUploadFiles(e.dataTransfer.files);
}
async function midxMoveDropped(e, folderId) {
    e.preventDefault();
    const id = e.dataTransfer && e.dataTransfer.getData('text/midx');
    if (!id) return;
    try {
        await fetch('/api/media/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder_id: folderId }) });
        loadMidias();
    } catch (err) { showToast('Erro ao mover.', 'danger'); }
}

// ---- preview ----
function midxPreview(id) {
    const it = (midxData.items || []).find(function (x) { return x.id === id; });
    if (!it) return;
    midxSendCtx = { id: it.id, nome: it.nome, tipo: it.tipo, legenda: it.legenda_padrao || '' };
    const url = '/api/media/' + id + '/raw';
    const body = document.getElementById('midx-preview-body');
    body.innerHTML =
        it.tipo === 'image' ? '<img src="' + url + '" style="max-width:100%; max-height:56vh; border-radius:8px;">' :
        it.tipo === 'video' ? '<video src="' + url + '" controls style="max-width:100%; max-height:56vh; border-radius:8px;"></video>' :
        it.tipo === 'audio' ? '<audio src="' + url + '" controls style="width:100%;"></audio>' :
        '<iframe src="' + url + '" style="width:100%; height:56vh; border:0; border-radius:8px; background:#fff;"></iframe>';
    document.getElementById('midx-preview-name').textContent = it.nome;
    document.getElementById('midx-preview-meta').textContent =
        (it.tipo || 'arquivo') + ' · ' + Math.max(1, Math.round((it.tamanho_bytes || 0) / 1024)) + ' KB';
    document.getElementById('midx-preview-legenda').value = it.legenda_padrao || '';
    document.getElementById('modalMidxPreview').classList.add('active');
}
async function midxSaveLegenda() {
    if (!midxSendCtx) return;
    const legenda = document.getElementById('midx-preview-legenda').value;
    try {
        await fetch('/api/media/' + midxSendCtx.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ legenda_padrao: legenda }) });
        midxSendCtx.legenda = legenda;
        const it = (midxData.items || []).find(function (x) { return x.id === midxSendCtx.id; });
        if (it) it.legenda_padrao = legenda;
        showToast('Legenda salva.', 'success');
    } catch (e) { showToast('Erro ao salvar a legenda.', 'danger'); }
}

// ---- enviar para lead ----
function midxOpenSend(id) {
    const it = (midxData.items || []).find(function (x) { return x.id === id; });
    if (!it) return;
    midxSendCtx = { id: it.id, nome: it.nome, tipo: it.tipo, legenda: it.legenda_padrao || '' };
    midxOpenSendModal();
}
function midxOpenSendFromPreview() {
    if (!midxSendCtx) return;
    document.getElementById('modalMidxPreview').classList.remove('active');
    midxOpenSendModal();
}
function midxOpenSendModal() {
    midxSendLead = null;
    document.getElementById('midx-send-file').textContent = midxSendCtx.nome;
    document.getElementById('midx-send-search').value = '';
    document.getElementById('midx-send-caption').value = midxSendCtx.legenda || '';
    document.getElementById('midx-send-leads').style.display = 'none';
    document.getElementById('midx-send-leads').innerHTML = '';
    document.getElementById('midx-send-chosen').style.display = 'none';
    document.getElementById('modalMidxSend').classList.add('active');
    if (!Array.isArray(leads) || !leads.length) { fetchLeadsFromServer(true); }
}
function midxRenderLeadPicker(q) {
    const box = document.getElementById('midx-send-leads');
    q = (q || '').trim().toLowerCase();
    if (!q) { box.style.display = 'none'; box.innerHTML = ''; return; }
    const digits = q.replace(/\D/g, '');
    const hits = (Array.isArray(leads) ? leads : []).filter(function (l) {
        return (l.nome || '').toLowerCase().includes(q) ||
            (digits.length >= 3 && String(l.telefone || '').replace(/\D/g, '').includes(digits));
    }).slice(0, 30);
    box.style.display = hits.length ? 'block' : 'none';
    box.innerHTML = hits.map(function (l) {
        const nm = JSON.stringify(String(l.nome || 'Lead')).replace(/"/g, '&quot;');
        return '<div class="midx-lead-row" onclick="midxPickLead(\'' + l.id + '\', ' + nm + ')">' +
            escapeHtml(l.nome || 'Lead') + ' <small>' + escapeHtml(l.telefone || '') + '</small></div>';
    }).join('') || '';
}
function midxPickLead(id, nome) {
    const l = (Array.isArray(leads) ? leads : []).find(function (x) { return x.id === id; });
    if (!l) return;
    midxSendLead = { id: l.id, nome: l.nome || nome, telefone: l.telefone };
    document.getElementById('midx-send-leads').style.display = 'none';
    document.getElementById('midx-send-search').value = '';
    const chosen = document.getElementById('midx-send-chosen');
    chosen.style.display = 'flex';
    chosen.innerHTML = '<i class="fa-solid fa-user" style="color:var(--accent-primary);"></i> ' +
        '<b>' + escapeHtml(midxSendLead.nome) + '</b> <span style="color:var(--text-muted);">' + escapeHtml(midxSendLead.telefone || '') + '</span>';
}
async function midxDoSend() {
    if (!midxSendCtx) return;
    if (!midxSendLead || !midxSendLead.telefone) { showToast('Escolha o paciente.', 'danger'); return; }
    const btn = document.getElementById('midx-send-btn');
    const caption = document.getElementById('midx-send-caption').value.trim();
    const msg = '[MEDIALIB:' + midxSendCtx.id + ']' + (caption ? ('[CAPTION:' + caption + ']') : '');
    if (btn) { btn.disabled = true; btn.classList.add('is-loading'); }
    try {
        const res = await fetch('/api/whatsapp/send', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: midxSendLead.telefone, message: msg }) });
        const j = await res.json().catch(function () { return {}; });
        if (!res.ok || j.success === false) throw new Error(j.error || 'Falha no envio');
        closeModals();
        showToast('Mídia enviada para ' + midxSendLead.nome + '.', 'success');
        if (window.currentActiveChat && window.currentActiveChat.phone === midxSendLead.telefone && typeof openChat === 'function') {
            openChat(midxSendLead.telefone, midxSendLead.nome, true);
        }
    } catch (e) {
        showToast(e.message || 'Erro ao enviar.', 'danger');
    } finally {
        if (btn) { btn.disabled = false; btn.classList.remove('is-loading'); }
    }
}

// ---- seletor a partir do chat ----
async function openMidxPicker() {
    if (!window.currentActiveChat || !window.currentActiveChat.phone) { showToast('Abra uma conversa primeiro.', 'danger'); return; }
    document.getElementById('modalMidxLib').classList.add('active');
    midxLibNav(null);
}
async function midxLibNav(folder) {
    midxLibFolder = folder;
    const grid = document.getElementById('midx-lib-grid');
    if (grid) grid.innerHTML = '<div class="midx-empty"><span class="amicro-loader"><span></span><span></span><span></span></span></div>';
    try {
        const res = await fetch('/api/media' + (folder ? ('?folder=' + encodeURIComponent(folder)) : ''));
        midxLibData = await res.json();
    } catch (e) { midxLibData = { folders: [], items: [], breadcrumb: [] }; }
    const crumb = document.getElementById('midx-lib-crumb');
    if (crumb) crumb.innerHTML = midxCrumbHtml(midxLibData) + ' — clique num arquivo para enviar nesta conversa.';
    if (!grid) return;
    const fh = (midxLibData.folders || []).map(function (f) {
        return '<div class="midx-tile midx-tile--folder" onclick="midxLibNav(\'' + f.id + '\')">' +
            '<i class="fa-solid fa-folder midx-tile-ic"></i><span class="midx-tile-name">' + escapeHtml(f.nome) + '</span></div>';
    }).join('');
    const ih = (midxLibData.items || []).map(function (i) {
        const thumb = i.tipo === 'image'
            ? '<img class="midx-tile-thumb" loading="lazy" src="' + (i.thumb_base64 ? ('data:image/jpeg;base64,' + i.thumb_base64) : ('/api/media/' + i.id + '/raw')) + '" alt="">'
            : '<i class="fa-solid ' + (i.tipo === 'video' ? 'fa-film' : i.tipo === 'audio' ? 'fa-music' : 'fa-file-lines') + ' midx-tile-ic"></i>';
        const leg = JSON.stringify(String(i.legenda_padrao || '')).replace(/"/g, '&quot;');
        return '<div class="midx-tile" onclick="midxLibPick(\'' + i.id + '\', ' + leg + ')">' +
            thumb + '<span class="midx-tile-name">' + escapeHtml(i.nome) + '</span></div>';
    }).join('');
    grid.innerHTML = (fh + ih) || '<div class="midx-empty"><i class="fa-solid fa-folder-open"></i><span>Vazio.</span></div>';
}
async function midxLibPick(id, legendaPadrao) {
    const caption = await customPrompt('Legenda (opcional):', legendaPadrao || '', 'Enviar mídia');
    if (caption === null) return;
    const to = window.currentActiveChat && window.currentActiveChat.phone;
    if (!to) return;
    const msg = '[MEDIALIB:' + id + ']' + (caption.trim() ? ('[CAPTION:' + caption.trim() + ']') : '');
    closeModals();
    try {
        const res = await fetch('/api/whatsapp/send', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: to, message: msg }) });
        const j = await res.json().catch(function () { return {}; });
        if (!res.ok || j.success === false) throw new Error(j.error || 'Falha no envio');
        if (typeof openChat === 'function') openChat(to, window.currentActiveChat.name, true);
    } catch (e) { showToast(e.message || 'Erro ao enviar.', 'danger'); }
}
