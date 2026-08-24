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
    if (!isoStr.endsWith('Z') && !isoStr.includes('+') && !isoStr.includes('-')) {
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

function initApp() {
    initTheme();
    if (loggedUser) {
        const overlay = document.getElementById('login-overlay');
        if(overlay) overlay.classList.remove('active');
        
        fetchLeadsFromServer(); // Busca na nuvem e renderiza todos os leads compartilhados
        fetchApiOptions();
        startNotificationPolling();
        loadAudiences();

        // Sincronização contínua do Kanban em tempo real para todos os atendentes
        if (!window.kanbanSyncInterval) {
            window.kanbanSyncInterval = setInterval(() => {
                if (loggedUser) {
                    fetchLeadsFromServer(true);
                }
            }, 5000);
        }
        
        if (loggedUser.role === 'admin' || loggedUser.username === 'admin') {
            const btnGestao = document.getElementById('flyout-gestao-acessos');
            if (btnGestao) {
                btnGestao.style.display = 'flex';
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

// === THEME MANAGER ===
function initTheme() {
    const savedTheme = localStorage.getItem('crm_theme') || 'dark';
    if (savedTheme === 'light') {
        document.body.setAttribute('data-theme', 'light');
        const icon = document.querySelector('#theme-toggle i');
        if (icon) {
            icon.classList.remove('fa-moon');
            icon.classList.add('fa-sun');
        }
    }
}

// Chuva de confete comemorando um agendamento novo. Canvas próprio, sem
// biblioteca externa, some sozinho ao fim da animação.
function celebrateAgendamento() {
    try {
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

        const canvas = document.createElement('canvas');
        canvas.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:99999;';
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        document.body.appendChild(canvas);
        const ctx = canvas.getContext('2d');

        const colors = ['#10b981', '#34d399', '#a78bfa', '#fbbf24', '#60a5fa', '#f87171'];
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
// Origem
if (origemVal && lead.origem !== origemVal) return false;
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

filteredLeads.forEach(lead => {
const col = document.getElementById(lead.column);
if (col) {
const card = document.createElement('div');
card.className = 'card';
card.draggable = true;
card.id = `card-${lead.id}`;
card.ondragstart = (e) => drag(e, lead.id);
card.ondragend = dragEnd;

// 1. Procedimento de Interesse (Extração com fallback inteligente)
let procedimentoName = '';
if (lead.orcamento) {
try {
const orc = typeof lead.orcamento === 'string' ? JSON.parse(lead.orcamento) : lead.orcamento;
procedimentoName = orc.procedimento || '';
} catch(e) {}
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
const diffTime = Math.abs(new Date() - createdDate);
const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
daysSince = `${diffDays}d atrás`;
}

// 3. Indicadores de Metadados
let metadataIconsHTML = '';
if (lead.notas) {
metadataIconsHTML += `<i class="fa-regular fa-note-sticky" style="color: var(--accent-warning); margin-right: 4px;" title="Possui observações salvas"></i> `;
}
if (lead.orcamento) {
metadataIconsHTML += `<i class="fa-solid fa-file-invoice-dollar" style="color: #a78bfa; margin-right: 4px;" title="Orçamento Gerado"></i> `;
}
if (lead.agendamento) {
metadataIconsHTML += `<i class="fa-regular fa-calendar-check" style="color: #2dd4bf; margin-right: 4px;" title="Agendamento Marcado: ${lead.agendamento.data} às ${lead.agendamento.hora}"></i> `;
}

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
<div style="font-size: 0.8rem; font-weight: 500; color: #a78bfa; margin-top: 0.05rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"><i class="fa-solid fa-spa" style="font-size: 0.72rem; margin-right: 4px;"></i> ${procedimentoName}</div>
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
} else if (l.orcamento) {
try {
const orc = typeof l.orcamento === 'string' ? JSON.parse(l.orcamento) : l.orcamento;
val = parseFloat(orc.valor) || 0;
} catch(e) {}
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
'col-perdido': { title: 'Nenhum contato arquivado', desc: 'Leads não qualificados ou sem interesse ficarão nesta etapa.', icon: 'fa-circle-xmark' }
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

function drag(ev, id) {
draggedCardId = id;
sourceColumnId = leads.find(l => l.id === id).column;
ev.dataTransfer.setData("text", id);
setTimeout(() => {
document.getElementById(`card-${id}`).classList.add('dragging');
}, 0);
}

function dragEnd(ev) {
if(draggedCardId) {
const el = document.getElementById(`card-${draggedCardId}`);
if(el) el.classList.remove('dragging');
}
}

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

// Se moveu para agendado, abre o modal de integração
if (targetColumnId === 'col-agendado') {
celebrateAgendamento();
openAgendamentoModal(draggedCardId);
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
dropdown.innerHTML = `<div style="padding:0.8rem 1rem; color:var(--text-muted); font-size:0.85rem;"><i class="fa-solid fa-spinner fa-spin"></i> Buscando pacientes...</div>`;
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
const doLeads = (leads || [])
.filter(l => l.nome && l.nome.toLowerCase().includes(termoLower))
.map(l => ({ nome: l.nome, telefone: l.telefone || '', fonte: 'CRM' }));

// Junta resultados (Amigo App + CRM local), sem duplicatas
const vistos = new Set(doLeads.map(l => l.nome.toLowerCase()));
const doAmigo = pacientes
.filter(p => !vistos.has(p.nome.toLowerCase()))
.map(p => ({ id: p.id, nome: p.nome, telefone: p.telefone || '', email: p.email || '', born: p.born || '', fonte: 'Amigo App' }));

const todos = [...doLeads, ...doAmigo];

if (todos.length === 0) {
dropdown.innerHTML = `<div style="padding:0.8rem 1rem; color:var(--text-muted); font-size:0.85rem;"><i class="fa-solid fa-user-slash"></i> Nenhum paciente encontrado. Preencha para cadastrar.</div>`;
return;
}

dropdown.innerHTML = todos.map(r => `
<div onclick="selecionarPaciente('${r.nome.replace(/'/g, "\\'")}', '${(r.telefone || '').replace(/'/g, "\\'")}', '${r.id || ''}', '${(r.email || '').replace(/'/g, "\\'")}', '${(r.born || '').replace(/'/g, "\\'")}')"
style="padding: 0.7rem 1rem; cursor: pointer; border-bottom: 1px solid var(--border-color); transition: background 0.15s;"
onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='transparent'">
<div style="font-weight: 600; color: var(--text-color);">${r.nome}</div>
<div style="font-size: 0.8rem; color: var(--text-muted);">
<i class="fa-solid fa-phone" style="font-size:0.7rem;"></i> ${r.telefone || 'Sem telefone'} 
&nbsp;<span style="background: ${r.fonte === 'CRM' ? 'rgba(99,102,241,0.2)' : 'rgba(251,146,60,0.2)'}; color: ${r.fonte === 'CRM' ? 'var(--accent-primary)' : '#fb923c'}; font-size:0.7rem; padding: 1px 6px; border-radius: 4px;">${r.fonte}</span>
</div>
</div>
`).join('');

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

    if (lead) {
        const wasAlreadyAgendado = lead.column === 'col-agendado';
        lead.column = newColumn;
        renderBoard();
        await updateLeadColumnOnServer(lead.id, newColumn);
        if (newColumn === 'col-agendado' && !wasAlreadyAgendado) {
            celebrateAgendamento();
            openAgendamentoModal(lead.id);
        }
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
        if (newColumn === 'col-agendado') {
            celebrateAgendamento();
            openAgendamentoModal(newLead.id);
        }
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
    document.getElementById('ln-lead-valor').value = lead.valor_recebido || '';
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
    const valor_recebido = document.getElementById('ln-lead-valor').value;
    
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
}

function openOrcamentoModal(id) {
    const lead = leads.find(l => l.id === id);
    if (!lead) return;
    document.getElementById('orc-lead-id').value = id;
    
    // Parse if it exists
    let orc = {};
    try {
        orc = lead.orcamento ? (typeof lead.orcamento === 'string' ? JSON.parse(lead.orcamento) : lead.orcamento) : {};
    } catch(e) {}

    document.getElementById('orc-procedimento').value = orc.procedimento || '';
    document.getElementById('orc-valor').value = orc.valor || '';
    document.getElementById('orc-desconto').value = orc.desconto || '';
    document.getElementById('orc-condicoes').value = orc.condicoes || '';
    
    document.getElementById('modalOrcamento').classList.add('active');
}

async function saveOrcamento() {
    const id = document.getElementById('orc-lead-id').value;
    const procedimento = document.getElementById('orc-procedimento').value;
    const valor = document.getElementById('orc-valor').value;
    const desconto = document.getElementById('orc-desconto').value;
    const condicoes = document.getElementById('orc-condicoes').value;
    
    const lead = leads.find(l => l.id === id);
    if (lead) {
        const orc = { procedimento, valor, desconto, condicoes };
        lead.orcamento = JSON.stringify(orc);
        
        // Ensure it is in col-orcado locally
        if (lead.column !== 'col-orcado') {
            lead.column = 'col-orcado';
        }

        renderBoard();
        
        try {
            await fetch(`/api/leads/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                   column_id: lead.column,
                   orcamento: lead.orcamento 
                })
            });
        } catch (e) {
            console.error('Erro ao salvar orcamento', e);
        }
    }
    
    document.getElementById('modalOrcamento').classList.remove('active');
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
    if (confirmBtn) confirmBtn.innerText = "Agendar no Sistema";
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
    if (!window.currentEditingAttendance) return;
    
    if (typeof loggedUser === 'undefined' || !loggedUser || loggedUser.role !== 'admin') {
        customAlert("Apenas administradores podem editar o histórico de agendamento.");
        return;
    }
    
    closePatientDetailsModal();
    resetAgendamentoForm();
    
    const att = window.currentEditingAttendance;
    
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
    if (confirmBtn) confirmBtn.innerText = "Atualizar no Amigo App";
    
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
        if (confirmBtn) confirmBtn.innerText = "Agendar no Sistema";
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
    window.location.href = '/api/export-csv';
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
    const gap = 8;
    flyout.style.left = Math.round(rect.right + gap) + 'px';
    flyout.style.top = Math.round(rect.top) + 'px';
    flyout.style.display = 'flex';
    flyout.style.flexDirection = 'column';
    flyout.style.zIndex = '9999';

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
    }, 250);
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
    const relFlyout = document.getElementById('relacionamento-flyout');
    if (relFlyout) relFlyout.style.display = 'none';
    const campFlyout = document.getElementById('campanhas-flyout');
    if (campFlyout) campFlyout.style.display = 'none';

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
        if (!window.dashGoalLoaded) {
            window.dashGoalLoaded = true;
            loadDashboardGoal().then(renderDashboard);
        }
        renderDashboard(); // Render charts and metrics
        // Inicia auto-refresh a cada 30s enquanto o dashboard estiver aberto
        if (!window.dashPollingInterval) {
            window.dashPollingInterval = setInterval(async () => {
                if (document.getElementById('view-dashboard')?.style.display !== 'none') {
                    await fetchLeadsFromServer(true);
                    renderDashboard();
                }
            }, 10000);
        }
    } else if (tabId === 'campanhas') {
        const view = document.getElementById('view-campanhas');
        if (view) view.style.display = 'flex';
        loadWhatsappTemplates();
        loadAudiences().then(updateCampaignLeadCount);
    } else if (tabId === 'origem-leads') {
        const view = document.getElementById('view-origem-leads');
        if (view) view.style.display = 'flex';
        if (typeof loadCampaigns === 'function') loadCampaigns();
    } else if (tabId === 'agenda') {
        document.getElementById('view-agenda').style.display = 'flex';
        renderAgendaGrid();
    } else if (tabId === 'chat') {
        if (typeof hideChatNotificationDot === 'function') hideChatNotificationDot();
        const view = document.getElementById('view-chat');
        if (view) {
            view.style.display = 'flex';
            loadChats();
            // Inicia polling se ainda não estiver rodando
            if (!window.chatPollingInterval) {
                window.chatPollingInterval = setInterval(() => {
                    if(document.getElementById('view-chat').style.display !== 'none') {
                        loadChats(true);
                        if(window.currentActiveChat) {
                            openChat(window.currentActiveChat.phone, window.currentActiveChat.name, true);
                        }
                    }
                }, 5000);
            }
        }
    } else if (['posvenda', 'faltantes', 'sumidos', 'aniversariantes'].includes(tabId)) {
        const view = document.getElementById(`view-${tabId}`);
        if (view) {
            view.style.display = 'flex';
            if (tabId === 'aniversariantes') {
                fetchAniversariantesHoje();
                fetchAniversariantesMes();
            } else {
                fetchRelacionamento();
            }
        }
    }
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
    
    if (list.length === 0) {
        container.innerHTML = `<div style="color: var(--text-muted); text-align: center; grid-column: 1 / -1; margin-top: 2rem;">Nenhum paciente encontrado.</div>`;
        return;
    }
    
    container.innerHTML = list.map(item => cardRenderer(item)).join('');
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

async function loadUsers() {
    const tbody = document.getElementById('usuarios-tbody');
    tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; padding: 1rem;"><i class="fa-solid fa-spinner spin"></i> Carregando...</td></tr>';
    
    try {
        const res = await fetch('/api/users');
        const users = await res.json();
        
        tbody.innerHTML = '';
        users.forEach(u => {
            const tr = document.createElement('tr');
            tr.style.borderBottom = '1px solid var(--border-color)';
            tr.innerHTML = `
                <td style="padding: 0.75rem 1rem; color: var(--text-main); font-weight: 500;">${u.username}</td>
                <td style="padding: 0.75rem 1rem;">
                    <span style="background: ${u.role === 'admin' ? 'var(--accent-warning)' : 'var(--accent-primary)'}; color: ${u.role === 'admin' ? '#000' : '#fff'}; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600;">
                        ${u.role}
                    </span>
                </td>
                <td style="padding: 0.75rem 1rem; text-align: right;">
                    ${u.username !== 'admin' ? `<button class="btn-cancel" onclick="deleteUser('${u.username}')" style="padding: 0.3rem 0.6rem; font-size: 0.8rem;"><i class="fa-solid fa-trash"></i></button>` : ''}
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: red;">Erro ao carregar usuários</td></tr>`;
    }
}

async function createUser() {
    const username = document.getElementById('nu-user').value.trim();
    const password = document.getElementById('nu-pass').value.trim();
    const role = document.getElementById('nu-role').value;
    
    if (!username || !password) return await customAlert('Preencha usuário e senha!');
    
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
        loadUsers();
    } catch (e) {
        await customAlert(e.message);
    }
}

async function deleteUser(username) {
    if (!await customConfirm(`Tem certeza que deseja excluir o acesso de ${username}?`)) return;
    try {
        const res = await fetch(`/api/users/${username}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
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

        // Adicionar qualquer profissional que esteja nos agendamentos mas não veio na lista de doctors
        attendances.forEach(att => {
            if (att.user && att.user.id && !doctorsMap.has(att.user.id)) {
                doctorsMap.set(att.user.id, { id: att.user.id, name: att.user.name });
            }
        });

        let doctors = Array.from(doctorsMap.values());
        
        // Ordenar alfabeticamente para manter a ordem das colunas consistente
        doctors.sort((a, b) => a.name.localeCompare(b.name));

        if (doctors.length === 0) {
            doctors = [{ id: 0, name: 'Carregando / Sem Profissionais' }];
        }
        
        // 2. Ajustar CSS Grid Dinâmico
        gridLayout.style.setProperty('--col-count', doctors.length);
        
        // 3. Renderizar Cabeçalhos das Colunas
        gridLayout.insertAdjacentHTML('afterbegin', `<div class="grid-col-header time-col-header">Horário</div>`);
        doctors.forEach(doc => {
            gridLayout.insertAdjacentHTML('beforeend', `<div class="grid-col-header">${doc.name}</div>`);
        });
        
        // O Grid Body precisa ficar DEPOIS dos headers
        gridLayout.appendChild(gridBody);
        
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
                    let extraStyles = `background: var(--agenda-${colorVar}-bg); border: 1px solid var(--agenda-${colorVar}-border); border-left: 4px solid var(--agenda-${colorVar}-border); color: var(--agenda-${colorVar}-text);`;
                    
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
                    
                    const inlineStyle = `grid-column: ${col}; grid-row: ${rowStart} / ${rowEnd}; width: calc(${widthPct}% - 4px); margin-left: ${leftPct}%; z-index: ${zIndex}; box-shadow: 1px 2px 6px rgba(0,0,0,0.15); ${extraStyles}`;
                    
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
                        <div style="position: absolute; top: ${topPct}%; left: 0; right: 0; border-top: 1.5px solid #ef4444; box-shadow: 0 0 4px rgba(239, 68, 68, 0.4);"></div>
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

    if (aniversariantesHojeData.length === 0) {
        list.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 2rem; color: var(--text-muted);">Nenhum aniversariante encontrado hoje pela API.</td></tr>';
        document.getElementById('count-aniversariantes-hoje').innerText = '0';
        return;
    }
    
    document.getElementById('count-aniversariantes-hoje').innerText = aniversariantesHojeData.length;

    list.innerHTML = aniversariantesHojeData.map(p => {
        return `
            <tr style="background: rgba(245, 158, 11, 0.1); border-left: 3px solid var(--accent-warning);">
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
                    <a href="${getWhatsAppLink(p.phone, p.name, 'aniversariante')}" target="_blank" class="btn-secondary" style="width: 100%; justify-content: center; background: rgba(16, 185, 129, 0.15); color: var(--accent-success); border-color: rgba(16, 185, 129, 0.3); text-decoration: none; padding: 0.5rem;">
                        <i class="fa-brands fa-whatsapp"></i> Parabéns
                    </a>
                </td>
            </tr>
        `;
    }).join('');
}

function renderAniversariantesMes() {
    const list = document.getElementById('list-aniversariantes-mes');
    if (!list) return;

    if (aniversariantesMesData.length === 0) {
        list.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 2rem; color: var(--text-muted);">Planilha vazia ou não importada.</td></tr>';
        document.getElementById('count-aniversariantes-mes').innerText = '0';
        return;
    }
    
    document.getElementById('count-aniversariantes-mes').innerText = aniversariantesMesData.length;

    list.innerHTML = aniversariantesMesData.map(p => {
        const isTodayStyle = p.isToday ? 'background: rgba(16, 185, 129, 0.1); border-left: 3px solid var(--accent-success);' : '';
        const todayBadge = p.isToday ? '<span style="background: var(--accent-success); color: white; padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.7rem; margin-left: 0.5rem; font-weight: bold;">HOJE</span>' : '';
        
        return `
            <tr style="${isTodayStyle}">
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
                    <a href="${getWhatsAppLink(p.phone, p.name, 'aniversariante')}" target="_blank" class="btn-secondary" style="width: 100%; justify-content: center; background: rgba(16, 185, 129, 0.15); color: var(--accent-success); border-color: rgba(16, 185, 129, 0.3); text-decoration: none; padding: 0.5rem;">
                        <i class="fa-brands fa-whatsapp"></i> Parabéns
                    </a>
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
    btnLabel.innerHTML = '<i class="fa-solid fa-circle-notch spin"></i> Salvando...';

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
    document.getElementById('login-overlay').classList.remove('active');

    const flyoutGestao = document.getElementById('flyout-gestao-acessos');
    if (flyoutGestao) {
        flyoutGestao.style.display = (loggedUser.role === 'admin' || loggedUser.username === 'admin') ? 'flex' : 'none';
    }

    fetchLeadsFromServer();
    fetchApiOptions();
    startNotificationPolling();
    updateHeaderProfileUI();
    loadDisplayNamesMap();
    loadAvatarMap();
    loadUnidades();
    startHeartbeat();
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
    listEl.innerHTML = '<div style="text-align:center; padding:1.5rem; color: var(--text-muted);"><i class="fa-solid fa-circle-notch spin"></i> Carregando...</div>';

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

    if (badge) badge.style.display = 'none';

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
                document.getElementById('force-change-fields').style.display = 'block';
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
    }
}

async function submitForceChangePassword() {
    const badge = document.getElementById('login-error-badge');
    const badgeText = document.getElementById('login-error-text');
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
            document.getElementById('login-fields').style.display = 'block';
            // Faz login de novo já com a senha nova para abrir a sessão normalmente
            document.getElementById('login-password').value = newPassword;
            await performLogin();
        } else {
            if (badge) { badge.style.display = 'flex'; badgeText.innerText = data.error || 'Erro ao trocar a senha.'; }
        }
    } catch(e) {
        if (badge) { badge.style.display = 'flex'; badgeText.innerText = 'Falha de conexão com o servidor.'; }
    }
}

let seenNotifications = new Set();
let unreadNotifications = 0;
let isFirstLoad = true;

function startNotificationPolling() {
    // Busca inicial rápida, depois a cada 10s
    if (isFirstLoad) {
        fetchNotifications(true); 
    } else {
        fetchNotifications(false);
    }
    
    setInterval(() => {
        fetchNotifications(false);
    }, 10000);
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
                    
                    const iconHTML = n.avatar_url
                        ? `<img src="${n.avatar_url}" alt="" style="width: 26px; height: 26px; border-radius: 50%; object-fit: cover; flex-shrink: 0;">`
                        : `<i class="fa-solid fa-check-circle" style="color: var(--accent-success); flex-shrink: 0;"></i>`;

                    const item = document.createElement('div');
                    item.style = "padding: 0.75rem; border-radius: 6px; background: var(--bg-card); color: var(--text-main); font-size: 0.85rem; border-left: 4px solid var(--accent-success); margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.5rem; box-shadow: 0 2px 4px rgba(0,0,0,0.05);";
                    item.innerHTML = `${iconHTML} <div><strong>${timeStr}</strong> - ${escapeHtml(n.message)}</div>`;
                    listContainer.prepend(item);
                }
                
                if (!isFirstLoad) {
                    unreadNotifications++;
                    const badge = document.getElementById('nav-notification-badge');
                    if (badge) {
                        badge.innerText = unreadNotifications;
                        badge.style.display = 'flex';
                    }
                }
            }
        });
        isFirstLoad = false;
    } catch(e) {}
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
        const panelWidth = 320;
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
            listContainer.innerHTML = '<div style="padding: 1rem; text-align: center; color: var(--text-muted); font-size: 0.85rem;">Nenhuma notificação ainda.</div>';
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

const initFlatpickr = () => {
    if (typeof flatpickr !== "undefined") {
        flatpickr("input[type=date]", {
            locale: "pt",
            dateFormat: "Y-m-d",
            onChange: function(selectedDates, dateStr, instance) {
                // Seta o valor visualmente / no DOM
                instance.element.value = dateStr;
                
                // Puxa o onchange original (que deve ser jumpToDate(this.value))
                const onChangeAttr = instance.element.getAttribute('onchange');
                if (onChangeAttr) {
                    // Substitui o this.value pela data em string
                    const executableStr = onChangeAttr.replace(/this.value/g, "'" + dateStr + "'");
                    try {
                        eval(executableStr);
                    } catch(e) {
                        console.error('Error executing flatpickr onchange:', e);
                    }
                } else {
                    instance.element.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        });
    }
};
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initFlatpickr);
} else {
    initFlatpickr();
}
window.addEventListener("DOMContentLoaded", () => {
    if (typeof flatpickr !== "undefined") {
        flatpickr("input[type=date]", {
            locale: "pt",
            dateFormat: "Y-m-d"
        });
    }
});

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
    if (dashFpInstance) { dashFpInstance.open(); return; }
    dashFpInstance = flatpickr(inputEl, {
        mode: 'range',
        dateFormat: 'd/m/Y',
        locale: 'pt',
        allowInput: false,
        disableMobile: true,
        onChange: function(selectedDates) {
            if (selectedDates.length === 2) {
                dashCustomRange = { start: selectedDates[0], end: selectedDates[1] };
                dashActivePeriod = 'custom';

                // Deactivate preset buttons
                document.querySelectorAll('.dash-preset-btn').forEach(b => b.classList.remove('active'));

                // Show clear X
                const clearBtn = document.getElementById('dash-daterange-clear');
                if (clearBtn) clearBtn.style.display = '';

                renderDashboard();
            }
        }
    });
    dashFpInstance.open();
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

    let receitaTotal = 0, agendamentosComValor = 0;
    let leadsAtivos = 0, agendadosTotal = 0, ganhosTotal = 0, perdidosTotal = 0;
    let leadsContatados = 0; // Leads que entraram no período selecionado
    let perdasTotal = 0;
    const rankingMap = {};
    const origemMap = {};

    leads.forEach(lead => {
        let val = parseFloat(lead.valor_recebido) || 0;
        if (!val && lead.orcamento) {
            try {
                const orc = typeof lead.orcamento === 'string' ? JSON.parse(lead.orcamento) : lead.orcamento;
                val = parseFloat(orc.valor) || 0;
            } catch(e) {}
        }
        const inPeriod = isInPeriod(lead.created_at);
        // Receita é filtrada pela data em que o valor foi definido (orçado/agendado/ganho),
        // não pela data de criação do lead — um lead antigo cujo orçamento só foi fechado
        // agora precisa contar no período atual, não sumir por ter entrado no CRM há meses.
        const revenueInPeriod = isInPeriod(lead.data_valor || lead.created_at);

        const orig = lead.origem || 'Não informado';
        origemMap[orig] = (origemMap[orig] || 0) + 1;

        // Conta leads que entraram no período selecionado
        if (inPeriod) leadsContatados++;

        if (lead.column === 'col-ganho') {
            ganhosTotal++;
            if (revenueInPeriod) { receitaTotal += val; if (val > 0) agendamentosComValor++; }
        } else if (lead.column === 'col-agendado') {
            agendadosTotal++;
            if (revenueInPeriod) { receitaTotal += val; if (val > 0) agendamentosComValor++; }
        } else if (lead.column === 'col-perdido') {
            perdidosTotal++;
            if (revenueInPeriod) perdasTotal += val;
        } else {
            leadsAtivos++;
        }

        const owner = lead.owner_id || 'Sem Dono';
        if (!rankingMap[owner]) rankingMap[owner] = { name: owner, leads: 0, agendamentos: 0, receita: 0 };
        rankingMap[owner].leads++;
        if (lead.column === 'col-agendado' || lead.column === 'col-ganho') {
            rankingMap[owner].agendamentos++;
            if (revenueInPeriod) rankingMap[owner].receita += val;
        }
    });

    const ticketMedio = agendamentosComValor > 0 ? (receitaTotal / agendamentosComValor) : 0;
    const taxaConversao = leads.length > 0 ? Math.round(((agendadosTotal + ganhosTotal) / leads.length) * 100) : 0;

    const el = id => document.getElementById(id);
    if (el('dash-receita-total')) el('dash-receita-total').innerText = 'R$ ' + receitaTotal.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    if (el('dash-ticket-medio')) el('dash-ticket-medio').innerText = 'R$ ' + ticketMedio.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    if (el('dash-leads-ativos')) el('dash-leads-ativos').innerText = leadsAtivos;
    if (el('dash-taxa-resposta')) el('dash-taxa-resposta').innerText = taxaConversao + '%';
    if (el('dash-agendamentos-total')) el('dash-agendamentos-total').innerText = agendadosTotal + ganhosTotal;
    if (el('dash-leads-hoje')) el('dash-leads-hoje').innerText = leadsContatados;
    if (el('dash-perdas-total')) el('dash-perdas-total').innerText = 'R$ ' + perdasTotal.toLocaleString('pt-BR', { minimumFractionDigits: 2 });

    // Ranking - premium cards
    const rankingArray = Object.values(rankingMap).sort((a, b) => b.receita - a.receita);
    const rankingBody = el('dash-ranking-body');
    if (rankingBody) {
        const medals = ['🥇', '🥈', '🥉'];
        // Barra proporcional ao maior número de leads do ranking — antes usava o
        // "leads" de quem tinha mais receita, o que deixava as barras sem sentido
        // quando a receita empatava (ex.: tudo zerado).
        const maxLeads = Math.max(...rankingArray.map(r => r.leads), 1);
        rankingBody.innerHTML = rankingArray.length === 0
            ? '<div style="color: var(--text-muted); font-size: 0.85rem; text-align: center; padding: 1rem;">Nenhum atendente ainda.</div>'
            : rankingArray.map((r, idx) => {
                const conv = r.leads > 0 ? Math.round((r.agendamentos / r.leads) * 100) : 0;
                const barPct = Math.round((r.leads / maxLeads) * 100);
                const medal = medals[idx] || (idx + 1) + 'º';
                return `<div style="display: flex; align-items: center; gap: 1rem; padding: 0.85rem 1rem; background: var(--header-btn-bg); border-radius: 12px; border: 1px solid var(--header-btn-border);">
                    <div style="font-size: 1.3rem; min-width: 2rem; text-align: center;">${medal}</div>
                    <div style="flex: 1; min-width: 0;">
                        <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 0.35rem;">
                            <span style="font-weight: 700; color: var(--text-main); font-size: 0.9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px;">${r.name}</span>
                            <span style="font-size: 0.78rem; color: var(--text-muted);">${r.leads} leads &middot; ${conv}% conv.</span>
                        </div>
                        <div style="height: 5px; background: var(--header-btn-bg); border-radius: 99px; overflow: hidden;">
                            <div style="height: 100%; width: ${barPct}%; background: var(--accent-primary); border-radius: 99px;"></div>
                        </div>
                    </div>
                    <div style="text-align: right; white-space: nowrap;">
                        <div style="font-weight: 700; color: #10b981; font-size: 0.9rem;">R$ ${r.receita.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</div>
                        <div style="font-size: 0.72rem; color: var(--text-muted);">${r.agendamentos} agend.</div>
                    </div>
                </div>`;
            }).join('');
    }

    renderDashboardGoal(receitaTotal);
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
        bar.style.width = pct + '%';
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
}

function cancelDashGoalEdit() {
    const editor = document.getElementById('dash-goal-editor');
    if (editor) editor.style.display = 'none';
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
    if (listEl) listEl.innerHTML = `<div style="text-align:center; padding: 1rem 0; color: var(--text-muted); font-size: 0.85rem;"><i class="fa-solid fa-circle-notch fa-spin"></i> Carregando...</div>`;

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
        leadsChartInst = new Chart(ctxLeads, {
            type: 'line',
            data: {
                labels: days,
                datasets: [{
                    label: 'Novos Leads',
                    data: counts,
                    borderColor: '#60a5fa',
                    backgroundColor: (ctx) => {
                        const gradient = ctx.chart.ctx.createLinearGradient(0, 0, 0, 260);
                        gradient.addColorStop(0, 'rgba(96,165,250,0.35)');
                        gradient.addColorStop(1, 'rgba(96,165,250,0)');
                        return gradient;
                    },
                    tension: 0.45,
                    fill: true,
                    pointBackgroundColor: '#60a5fa',
                    pointRadius: 4,
                    pointHoverRadius: 6,
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
                scales: {
                    x: { grid: { color: gridColor }, ticks: { color: textColor, font: { size: 11 } } },
                    y: { grid: { color: gridColor }, ticks: { color: textColor, font: { size: 11 }, stepSize: 1 }, beginAtZero: true }
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

    const ctxFunnel = document.getElementById('funnelChart');
    if (ctxFunnel) {
        if (funnelChartInst) funnelChartInst.destroy();
        funnelChartInst = new Chart(ctxFunnel, {
            type: 'bar',
            data: {
                labels: ['Entrada', 'Contatado', 'Orçado', 'Agendado', 'Ganho', 'Perdido'],
                datasets: [{
                    label: 'Quantidade',
                    data: [colEnt, colCont, colOrc, colAgen, colGanho, colPerd],
                    backgroundColor: ['rgba(96,165,250,0.8)', 'rgba(245,158,11,0.8)', 'rgba(56,189,248,0.8)', 'rgba(167,139,250,0.8)', 'rgba(16,185,129,0.8)', 'rgba(239,68,68,0.8)'],
                    borderRadius: 8,
                    borderSkipped: false
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
                scales: {
                    x: { grid: { display: false }, ticks: { color: textColor, font: { size: 10 } } },
                    y: { grid: { color: gridColor }, ticks: { color: textColor, font: { size: 11 }, stepSize: 1 }, beginAtZero: true }
                }
            }
        });
    }

    // Origem Doughnut Chart
    const origemLabels = Object.keys(origemMap);
    const origemValues = Object.values(origemMap);
    const origemColors = ['#60a5fa', '#f59e0b', '#10b981', '#a78bfa', '#38bdf8', '#fb923c', '#f472b6'];

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
                        hoverOffset: 6
                    }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    cutout: '68%',
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

    const max = Math.max(eligibleCount, 1);
    slider.max = String(max);
    slider.value = String(max);
    slider.disabled = eligibleCount === 0;
    if (display) display.textContent = String(eligibleCount);
    if (hint) {
        hint.textContent = eligibleCount === 0
            ? 'Nenhum lead elegível nesse público (sem opt-in confirmado, todos já receberam esse template, ou pediram pra não receber campanhas).'
            : `Arraste pra limitar quantos dos ${eligibleCount} leads elegíveis recebem esse disparo.`;
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

    // Se o corpo do template tem variável (ex: "Olá {{1}}"), a Meta exige um
    // parâmetro pra cada uma — sem isso o envio falha com o erro #132000
    // "Number of parameters does not match". Hoje só suportamos o caso mais comum
    // (uma variável = nome do lead); templates com mais de uma são bloqueados aqui
    // pra não mandar disparo pela metade pra centenas de leads.
    const selectedTemplate = cachedWhatsappTemplates.find(t => t.name === templateName && t.language === languageCode);
    const bodyComponent = selectedTemplate ? (selectedTemplate.components || []).find(c => c.type === 'BODY') : null;
    const bodyVarCount = bodyComponent && bodyComponent.text ? (bodyComponent.text.match(/\{\{\d+\}\}/g) || []).length : 0;
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
        alert('Não foi possível verificar quais leads são elegíveis pra essa campanha. Por segurança, o disparo foi cancelado — tente novamente.');
        return;
    }

    if (targetLeads.length === 0) {
        alert("Nenhum lead elegível: todos já receberam esse template, nunca conversaram por WhatsApp, ou pediram pra não receber campanhas.");
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

    if (!confirm(confirmMsg)) {
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Disparando...';
    logBox.innerHTML = `<div>Iniciando campanha para ${targetLeads.length} leads...</div>`;
    statusText.innerText = "Em progresso...";
    statusText.style.color = "var(--accent-info)";
    progressBar.style.width = "0%";

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < targetLeads.length; i++) {
        const lead = targetLeads[i];
        let phone = lead.telefone.replace(/\D/g, '');
        if (!phone.startsWith('55') && phone.length <= 11) {
            phone = '55' + phone;
        }

        try {
            const res = await fetch('/api/whatsapp/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    to: phone,
                    isTemplate: true,
                    templateName: templateName,
                    languageCode: languageCode,
                    templateParams: bodyVarCount === 1 ? [lead.nome || 'Cliente'] : undefined,
                    message: "template" // Placeholder required by backend
                })
            });

            const data = await res.json();
            if (data.success) {
                successCount++;
                logBox.innerHTML += `<div style="color: var(--accent-success);">[OK] ${lead.nome} (${phone})</div>`;
            } else {
                failCount++;
                logBox.innerHTML += `<div style="color: var(--accent-danger);">[FALHA] ${lead.nome} (${phone}): ${data.error || 'Erro'}</div>`;
            }
        } catch (e) {
            failCount++;
            logBox.innerHTML += `<div style="color: var(--accent-danger);">[FALHA] ${lead.nome} (${phone}): ${e.message}</div>`;
        }

        const pct = Math.round(((i + 1) / targetLeads.length) * 100);
        progressBar.style.width = `${pct}%`;
        progressText.innerText = `${i + 1} / ${targetLeads.length} processados`;
        logBox.scrollTop = logBox.scrollHeight;

        // Rate limit: ~1-1.6s entre mensagens, com variação, pra não ter um padrão
        // perfeitamente robótico de envio (um dos sinais que a Meta usa pra detectar spam).
        const jitterDelay = 1000 + Math.floor(Math.random() * 600);
        await new Promise(r => setTimeout(r, jitterDelay));
    }

    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Iniciar Disparo';
    statusText.innerText = `Concluído: ${successCount} Sucessos, ${failCount} Falhas.`;
    statusText.style.color = failCount === 0 ? "var(--accent-success)" : "var(--accent-warning)";
    logBox.innerHTML += `<div><strong>Campanha finalizada!</strong></div>`;
    logBox.scrollTop = logBox.scrollHeight;
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
    if (listEl) listEl.innerHTML = `<div class="utm-empty-state" style="flex: 1; justify-content: center;"><i class="fa-solid fa-circle-notch fa-spin" style="font-size: 1.6rem;"></i><span>Carregando templates...</span></div>`;

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


// === CONTROLE DE MENU DE OPÇÕES DO CARD ===
let activeCardMenuId = null;

window.toggleCardDropdown = function(event, leadId) {
    event.preventDefault();
    event.stopPropagation();
    
    const menu = document.getElementById('card-global-dropdown');
    if (!menu) return;
    
    if (menu.style.display === 'block' && activeCardMenuId === leadId) {
        menu.style.display = 'none';
        activeCardMenuId = null;
        return;
    }
    
    activeCardMenuId = leadId;
    
    const lead = leads.find(l => l.id === leadId);
    const orcItem = document.getElementById('card-menu-item-orc');
    if (orcItem && lead) {
        // Exibe o item de orçamento apenas se o lead estiver na coluna de orçado ou já tiver orçamento
        if (lead.column === 'col-orcado' || lead.orcamento) {
            orcItem.style.display = 'flex';
        } else {
            orcItem.style.display = 'none';
        }
    }

    const rect = event.currentTarget.getBoundingClientRect();
    let top = rect.bottom + window.scrollY;
    let left = rect.left + window.scrollX - 140;
    
    if (left < 10) left = 10;
    
    // Abre para cima se não couber na parte inferior
    if (rect.bottom + 180 > window.innerHeight) {
        top = rect.top + window.scrollY - 150;
    }
    
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
    menu.style.position = 'absolute';
    menu.style.display = 'block';
};

// Fechar menu ao clicar fora
document.addEventListener('click', function(e) {
    const menu = document.getElementById('card-global-dropdown');
    if (menu && menu.style.display === 'block') {
        if (!menu.contains(e.target) && !e.target.closest('.card-options-btn')) {
            menu.style.display = 'none';
            activeCardMenuId = null;
        }
    }
});

window.triggerCardAction = function(action) {
    const leadId = activeCardMenuId;
    
    const menu = document.getElementById('card-global-dropdown');
    if (menu) menu.style.display = 'none';
    activeCardMenuId = null;

    if (!leadId) return;
    const lead = leads.find(l => l.id === leadId);
    if (!lead) return;

    if (action === 'chat') {
        openLeadChat(lead.telefone, lead.nome);
    } else if (action === 'ficha') {
        openNotesModal(leadId);
    } else if (action === 'orcamento') {
        openOrcamentoModal(leadId);
    } else if (action === 'excluir') {
        deleteLead(leadId);
    }
};
