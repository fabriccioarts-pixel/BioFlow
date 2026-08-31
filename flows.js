/* ============================================================================
   FLUXOS DE ATENDIMENTO — editor visual de nodes
   Um fluxo é um grafo: um GATILHO + PASSOS ligados por transições
   ("próximo", "SIM/NÃO", "resposta/expira"). O backend roda esse grafo quando
   chega mensagem no WhatsApp, ANTES do agente de IA.
   Canvas vanilla (pan/zoom/arrastar/ligar), sem dependência externa.
   ========================================================================== */

const FLOW_NODE_DEFS = {
    enviar_texto:      { label: 'Enviar mensagem',            icon: 'fa-comment',           ports: [{ slot: 'next', label: '', cls: '' }] },
    aguardar_resposta: { label: 'Aguardar resposta',          icon: 'fa-clock',             ports: [{ slot: 'next', label: 'resposta', cls: '' }, { slot: 'on_timeout', label: 'expira', cls: 'amber' }] },
    condicao:          { label: 'Condição (SE/SENÃO)',        icon: 'fa-code-branch',       ports: [{ slot: 'on_true', label: 'SIM', cls: 'green' }, { slot: 'on_false', label: 'NÃO', cls: 'red' }] },
    delay:             { label: 'Esperar um tempo',           icon: 'fa-hourglass-half',    ports: [{ slot: 'next', label: '', cls: '' }] },
    mover_coluna:      { label: 'Mover no Kanban',            icon: 'fa-diagram-next',      ports: [{ slot: 'next', label: '', cls: '' }] },
    adicionar_tag:     { label: 'Adicionar etiqueta',         icon: 'fa-tag',               ports: [{ slot: 'next', label: '', cls: '' }] },
    definir_ia:        { label: 'Ligar / desligar IA',        icon: 'fa-robot',             ports: [{ slot: 'next', label: '', cls: '' }] },
    entregar_ia:       { label: 'Entregar para a IA',         icon: 'fa-robot',             ports: [] },
    handoff:           { label: 'Passar para atendente',      icon: 'fa-headset',           ports: [] },
    fim:               { label: 'Fim do fluxo',               icon: 'fa-flag-checkered',    ports: [] },
};
const FLOW_TRANS_LABEL = { next: 'Próximo passo', on_timeout: 'Se expirar', on_true: 'Se SIM', on_false: 'Se NÃO' };
const FLOW_SLOTS = ['next', 'on_true', 'on_false', 'on_timeout'];

let flowList = [];
let flowDraft = null;          // { id, nome, ativo, prioridade, version, graph:{trigger, nodes, start} }
let flowNodeSeq = 0;
let fxView = { panX: 240, panY: 30, zoom: 1 };
let fxSelected = null;         // id do node, '__trigger', ou null
let fxDrag = null;             // arrastar node
let fxConn = null;             // ligar ports

function flowIsAdmin() {
    return typeof loggedUser !== 'undefined' && loggedUser &&
        (loggedUser.role === 'admin' || loggedUser.username === 'admin');
}
function flowCols() {
    if (typeof KANBAN_COLUMNS !== 'undefined' && KANBAN_COLUMNS) return KANBAN_COLUMNS;
    return {
        'col-entrada': { label: 'Entrada' }, 'col-contatado': { label: 'Contatado' }, 'col-orcado': { label: 'Orçado' },
        'col-agendado': { label: 'Agendado' }, 'col-ganho': { label: 'Ganho' }, 'col-perdido': { label: 'Perdido' },
    };
}
function flowColOptions(sel) {
    return Object.entries(flowCols())
        .map(([k, v]) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${escapeHtml(v.label || k)}</option>`).join('');
}
function flowNodeTargetOptions(sel, excludeId) {
    const opts = (flowDraft.graph.nodes || []).filter(n => n.id !== excludeId)
        .map(n => `<option value="${n.id}" ${sel === n.id ? 'selected' : ''}>${n.id} · ${FLOW_NODE_DEFS[n.type] ? FLOW_NODE_DEFS[n.type].label : n.type}</option>`).join('');
    return `<option value="">— fim —</option>${opts}`;
}

/* ---------------- carregar / listar ---------------- */
async function loadFlows() {
    try { const r = await fetch('/api/flows').then(x => x.json()); flowList = r.flows || []; }
    catch (e) { flowList = []; }
    renderFlowList();
}
function renderFlowList() {
    const box = document.getElementById('fx-list');
    if (!box) return;
    if (!flowList.length) { box.innerHTML = '<div class="fx-list-empty">Nenhum fluxo ainda.</div>'; return; }
    box.innerHTML = flowList.map(f => `
        <button class="fx-list-item ${flowDraft && flowDraft.id === f.id ? 'is-active' : ''}" onclick="flowOpen('${f.id}')">
            <span class="fx-dot ${f.ativo ? 'on' : ''}"></span>
            <span class="fx-list-name">${escapeHtml(f.nome || 'Sem nome')}</span>
            ${f.ativo ? '<span class="fx-badge">ativo</span>' : ''}
        </button>`).join('');
}
async function flowNew() {
    if (!flowIsAdmin()) { showToast('Apenas administradores criam fluxos.', 'danger'); return; }
    try {
        const r = await fetch('/api/flows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nome: 'Novo fluxo' }) });
        const j = await r.json();
        if (!r.ok) { showToast(j.error || 'Erro ao criar.', 'danger'); return; }
        await loadFlows();
        flowOpen(j.id);
    } catch (e) { showToast('Erro ao criar fluxo.', 'danger'); }
}
async function flowOpen(id) {
    try {
        const r = await fetch('/api/flows/' + id).then(x => x.json());
        const f = r.flow;
        if (!f) { showToast('Fluxo não encontrado.', 'danger'); return; }
        let graph;
        try { graph = JSON.parse(f.graph_json || '{}'); } catch (e) { graph = {}; }
        if (!graph.trigger) graph.trigger = { type: 'primeira_mensagem', config: {} };
        if (!graph.trigger.config) graph.trigger.config = {};
        if (!Array.isArray(graph.nodes)) graph.nodes = [];
        if (!graph.start && graph.nodes[0]) graph.start = graph.nodes[0].id;
        flowDraft = { id: f.id, nome: f.nome || 'Sem nome', ativo: !!f.ativo, prioridade: f.prioridade || 0, version: f.version || 1, graph };
        flowNodeSeq = graph.nodes.reduce((m, n) => Math.max(m, parseInt(String(n.id).replace(/\D/g, ''), 10) || 0), 0);
        if (graph.trigger.x == null || graph.nodes.some(n => n.x == null)) flowAutoLayout(graph);
        fxSelected = null;
        fxView = { panX: 240, panY: 30, zoom: 1 };
        renderFlowList();
        renderFlowEditor();
    } catch (e) { showToast('Erro ao abrir fluxo.', 'danger'); }
}

function flowAutoLayout(graph) {
    const byId = {}; graph.nodes.forEach(n => { byId[n.id] = n; });
    const start = (graph.start && byId[graph.start]) ? graph.start : (graph.nodes[0] && graph.nodes[0].id);
    const depth = {};
    const queue = start ? [[start, 0]] : [];
    const seen = new Set();
    while (queue.length) {
        const [id, d] = queue.shift();
        if (seen.has(id)) { depth[id] = Math.max(depth[id] || 0, d); continue; }
        seen.add(id); depth[id] = d;
        const n = byId[id]; if (!n) continue;
        FLOW_SLOTS.forEach(s => { if (n[s] && byId[n[s]]) queue.push([n[s], d + 1]); });
    }
    let maxD = 0; Object.values(depth).forEach(d => { maxD = Math.max(maxD, d); });
    graph.nodes.forEach(n => { if (depth[n.id] == null) depth[n.id] = ++maxD; });
    const rows = {};
    graph.nodes.forEach(n => { (rows[depth[n.id]] = rows[depth[n.id]] || []).push(n); });
    Object.keys(rows).forEach(d => {
        rows[d].forEach((n, i) => { n.x = 20 + i * 250; n.y = 130 + Number(d) * 150; });
    });
    graph.trigger.x = 20; graph.trigger.y = 0;
}

/* ---------------- mutações ---------------- */
function flowNewNodeId() { flowNodeSeq += 1; return 'n' + flowNodeSeq; }

function flowAddNode(type) {
    const wrap = document.getElementById('fx-canvas-wrap');
    const cx = wrap ? (wrap.clientWidth / 2 - fxView.panX) / fxView.zoom - 100 : 200;
    const cy = wrap ? (wrap.clientHeight / 2 - fxView.panY) / fxView.zoom - 40 : 200;
    const id = flowNewNodeId();
    flowDraft.graph.nodes.push({ id, type: type || 'enviar_texto', config: {}, x: Math.round(cx), y: Math.round(cy) });
    if (flowDraft.graph.nodes.length === 1) flowDraft.graph.start = id;
    fxSelected = id;
    renderFlowEditor();
}
function flowRemoveNode(id) {
    const g = flowDraft.graph;
    g.nodes = g.nodes.filter(n => n.id !== id);
    g.nodes.forEach(n => FLOW_SLOTS.forEach(k => { if (n[k] === id) n[k] = null; }));
    if (g.start === id) g.start = g.nodes[0] ? g.nodes[0].id : null;
    if (fxSelected === id) fxSelected = null;
    renderFlowEditor();
}
function flowSetTrigger(field, value) {
    const t = flowDraft.graph.trigger;
    if (field === 'type') { t.type = value; const xy = { x: t.x, y: t.y }; t.config = {}; t.x = xy.x; t.y = xy.y; renderFlowDrawer(); flowDrawEdges(); return; }
    t.config[field] = value;
}
function flowSetNode(id, path, value) {
    const n = flowDraft.graph.nodes.find(x => x.id === id);
    if (!n) return;
    if (path === 'type') {
        n.type = value; n.config = {};
        FLOW_SLOTS.forEach(s => { if (s !== 'next') delete n[s]; });
        renderFlowEditor();
        return;
    }
    if (path.indexOf('config.') === 0) {
        n.config[path.slice(7)] = value;
        const prev = document.querySelector(`.fx-gnode[data-id="${id}"] .fx-gnode-preview`);
        if (prev) prev.textContent = flowNodePreview(n);
        return;
    }
    n[path] = value || null;                 // transição via <select> do drawer
    flowDrawEdges();
}
function flowSetStart(id) { flowDraft.graph.start = id || null; flowDrawEdges(); }

/* ---------------- render: esqueleto ---------------- */
function renderFlowEditor() {
    const box = document.getElementById('fx-editor');
    if (!box || !flowDraft) return;
    const d = flowDraft;
    box.innerHTML = `
        <div class="fx-editor-head">
            <input class="fx-name-input" value="${escapeHtml(d.nome)}" oninput="flowDraft.nome = this.value" placeholder="Nome do fluxo">
            <div class="fx-editor-actions">
                <label class="fx-switch"><input type="checkbox" ${d.ativo ? 'checked' : ''} onchange="flowDraft.ativo = this.checked"> Ativo</label>
                <label class="fx-mini">Prioridade <input type="number" style="width:52px" value="${d.prioridade}" oninput="flowDraft.prioridade = parseInt(this.value,10)||0"></label>
                <button class="btn-cancel" onclick="flowDelete()" title="Excluir fluxo"><i class="fa-solid fa-trash"></i></button>
                <button class="btn-save" onclick="flowSave()"><i class="fa-solid fa-floppy-disk"></i> Salvar</button>
            </div>
        </div>
        <div class="fx-stage">
            <div class="fx-canvas-wrap" id="fx-canvas-wrap">
                <div class="fx-canvas" id="fx-canvas">
                    <svg class="fx-edges" id="fx-edges" width="6000" height="6000"></svg>
                    <div id="fx-nodes-layer"></div>
                </div>
                <div class="fx-palette">
                    <span class="fx-palette-label">Adicionar passo</span>
                    ${Object.entries(FLOW_NODE_DEFS).map(([k, v]) => `<button onclick="flowAddNode('${k}')"><i class="fa-solid ${v.icon}"></i> ${v.label}</button>`).join('')}
                </div>
                <div class="fx-zoom">
                    <button onclick="flowZoom(-1)" title="Menos zoom">−</button>
                    <button onclick="flowZoomReset()" title="Enquadrar">⤾</button>
                    <button onclick="flowZoom(1)" title="Mais zoom">+</button>
                </div>
            </div>
            <aside class="fx-drawer" id="fx-drawer"></aside>
        </div>`;

    const wrap = document.getElementById('fx-canvas-wrap');
    wrap.addEventListener('pointerdown', flowCanvasPointerDown);
    wrap.addEventListener('wheel', flowCanvasWheel, { passive: false });

    flowApplyTransform();
    flowRenderNodes();
    renderFlowDrawer();
    requestAnimationFrame(flowDrawEdges);
}

function flowApplyTransform() {
    const c = document.getElementById('fx-canvas');
    if (c) c.style.transform = `translate(${fxView.panX}px, ${fxView.panY}px) scale(${fxView.zoom})`;
}

/* ---------------- render: nodes ---------------- */
function flowNodePreview(n) {
    const c = n.config || {};
    const cut = (s, len) => { s = String(s || ''); return s.length > len ? s.slice(0, len) + '…' : s; };
    switch (n.type) {
        case 'enviar_texto': return cut(c.texto, 46) || 'sem texto';
        case 'aguardar_resposta': return c.timeout_min ? `expira em ${c.timeout_min} min` : 'sem limite de tempo';
        case 'delay': return `esperar ${c.minutos || 5} min`;
        case 'condicao': return `${({ contem: 'contém', igual: 'igual a', comeca_com: 'começa com', regex: 'regex' })[c.modo || 'contem']} "${cut(c.valor, 20)}"`;
        case 'mover_coluna': return (flowCols()[c.coluna] && flowCols()[c.coluna].label) || 'escolher coluna';
        case 'adicionar_tag': return c.tag ? `#${cut(c.tag, 24)}` : 'escolher etiqueta';
        case 'definir_ia': return c.ligada ? 'ligar IA' : 'desligar IA';
        case 'handoff': return cut(c.motivo, 40) || 'notifica a equipe';
        case 'entregar_ia': return 'IA assume a conversa';
        case 'fim': return 'encerra aqui';
        default: return '';
    }
}
function flowTriggerPreview() {
    const t = flowDraft.graph.trigger, c = t.config || {};
    if (t.type === 'entrou_coluna') return 'coluna: ' + ((flowCols()[c.coluna] && flowCols()[c.coluna].label) || '—');
    if (t.type === 'palavra_chave') return 'palavras: ' + (c.palavras || '—');
    return 'primeira mensagem do lead';
}

function flowRenderNodes() {
    const layer = document.getElementById('fx-nodes-layer');
    if (!layer || !flowDraft) return;
    const g = flowDraft.graph;

    let html = `
        <div class="fx-gnode fx-gnode--trigger ${fxSelected === '__trigger' ? 'is-sel' : ''}" data-id="__trigger" style="left:${g.trigger.x || 0}px; top:${g.trigger.y || 0}px">
            <div class="fx-gnode-head" data-drag="__trigger"><i class="fa-solid fa-bolt"></i><span>Gatilho</span></div>
            <div class="fx-gnode-preview">${escapeHtml(flowTriggerPreview())}</div>
            <div class="fx-gnode-ports"><span class="fx-port-wrap"><span class="fx-port fx-port-out" data-node="__trigger" data-slot="__start"></span></span></div>
        </div>`;

    html += g.nodes.map(n => {
        const def = FLOW_NODE_DEFS[n.type] || FLOW_NODE_DEFS.fim;
        const ports = def.ports.length
            ? def.ports.map(p => `<span class="fx-port-wrap"><span class="fx-port fx-port-out ${p.cls}" data-node="${n.id}" data-slot="${p.slot}"></span>${p.label ? `<em>${p.label}</em>` : ''}</span>`).join('')
            : '<span class="fx-port-wrap fx-port-end">encerra</span>';
        return `
        <div class="fx-gnode ${fxSelected === n.id ? 'is-sel' : ''}" data-id="${n.id}" style="left:${n.x || 0}px; top:${n.y || 0}px">
            <span class="fx-port fx-port-in"></span>
            <div class="fx-gnode-head" data-drag="${n.id}"><i class="fa-solid ${def.icon}"></i><span>${escapeHtml(def.label)}</span></div>
            <div class="fx-gnode-preview">${escapeHtml(flowNodePreview(n))}</div>
            <div class="fx-gnode-ports">${ports}</div>
        </div>`;
    }).join('');

    layer.innerHTML = html;
}

/* ---------------- render: arestas ---------------- */
function flowLocalPoint(el) {
    const canvas = document.getElementById('fx-canvas');
    const cr = canvas.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: (r.left + r.width / 2 - cr.left) / fxView.zoom, y: (r.top + r.height / 2 - cr.top) / fxView.zoom };
}
function flowEdgePath(p1, p2) {
    const dy = Math.max(36, Math.abs(p2.y - p1.y) / 2);
    return `M ${p1.x} ${p1.y} C ${p1.x} ${p1.y + dy}, ${p2.x} ${p2.y - dy}, ${p2.x} ${p2.y}`;
}
function flowDrawEdges() {
    const svg = document.getElementById('fx-edges');
    const layer = document.getElementById('fx-nodes-layer');
    if (!svg || !layer || !flowDraft) return;
    const g = flowDraft.graph;
    const nodeEl = (id) => layer.querySelector(`.fx-gnode[data-id="${id}"]`);
    let out = '';

    const addEdge = (fromEl, slot, toId, cls) => {
        const toEl = nodeEl(toId);
        if (!fromEl || !toEl) return;
        const src = fromEl.querySelector(`.fx-port-out[data-slot="${slot}"]`);
        const dst = toEl.querySelector('.fx-port-in');
        if (!src || !dst) return;
        out += `<path class="fx-edge ${cls || ''}" data-from="${fromEl.dataset.id}" data-slot="${slot}" d="${flowEdgePath(flowLocalPoint(src), flowLocalPoint(dst))}"></path>`;
    };

    const trigEl = layer.querySelector('.fx-gnode--trigger');
    if (trigEl && g.start) addEdge(trigEl, '__start', g.start, 'start');
    g.nodes.forEach(n => {
        const el = nodeEl(n.id); if (!el) return;
        (FLOW_NODE_DEFS[n.type] ? FLOW_NODE_DEFS[n.type].ports : []).forEach(p => { if (n[p.slot]) addEdge(el, p.slot, n[p.slot], p.cls); });
    });
    svg.innerHTML = out;
}

/* ---------------- pan / zoom ---------------- */
function flowCanvasWheel(e) {
    e.preventDefault();
    const wrap = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - wrap.left, my = e.clientY - wrap.top;
    const nx = (mx - fxView.panX) / fxView.zoom, ny = (my - fxView.panY) / fxView.zoom;
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    fxView.zoom = Math.min(1.8, Math.max(0.35, fxView.zoom * factor));
    fxView.panX = mx - nx * fxView.zoom;
    fxView.panY = my - ny * fxView.zoom;
    flowApplyTransform(); flowDrawEdges();
}
function flowZoom(dir) {
    const wrap = document.getElementById('fx-canvas-wrap');
    const mx = wrap.clientWidth / 2, my = wrap.clientHeight / 2;
    const nx = (mx - fxView.panX) / fxView.zoom, ny = (my - fxView.panY) / fxView.zoom;
    fxView.zoom = Math.min(1.8, Math.max(0.35, fxView.zoom * (dir > 0 ? 1.15 : 0.87)));
    fxView.panX = mx - nx * fxView.zoom; fxView.panY = my - ny * fxView.zoom;
    flowApplyTransform(); flowDrawEdges();
}
function flowZoomReset() { fxView = { panX: 240, panY: 30, zoom: 1 }; flowApplyTransform(); flowDrawEdges(); }

/* ---------------- ponteiro: arrastar node / ligar port / pan / selecionar ---------------- */
function flowCanvasPointerDown(e) {
    if (e.button !== 0) return;
    const port = e.target.closest('.fx-port-out');
    const head = e.target.closest('.fx-gnode-head');
    const gnode = e.target.closest('.fx-gnode');
    const edge = e.target.closest('.fx-edge');

    if (port) {
        e.preventDefault();
        fxConn = { from: port.dataset.node, slot: port.dataset.slot, moved: false };
        const svg = document.getElementById('fx-edges');
        const tmp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        tmp.setAttribute('class', 'fx-edge fx-edge-temp');
        svg.appendChild(tmp);
        fxConn.tmp = tmp;
        fxConn.p1 = flowLocalPoint(port);
        window.addEventListener('pointermove', flowConnMove);
        window.addEventListener('pointerup', flowConnUp);
        return;
    }
    if (edge && !head) {
        // clicar na aresta = remover a ligação
        const from = edge.dataset.from, slot = edge.dataset.slot;
        if (from === '__trigger') flowDraft.graph.start = null;
        else { const n = flowDraft.graph.nodes.find(x => x.id === from); if (n) n[slot] = null; }
        flowRenderNodes(); flowDrawEdges();
        showToast('Ligação removida.', 'success');
        return;
    }
    if (head) {
        e.preventDefault();
        const id = head.dataset.drag;
        const obj = id === '__trigger' ? flowDraft.graph.trigger : flowDraft.graph.nodes.find(n => n.id === id);
        if (!obj) return;
        fxDrag = { id, obj, sx: e.clientX, sy: e.clientY, ox: obj.x || 0, oy: obj.y || 0, moved: false };
        window.addEventListener('pointermove', flowDragMove);
        window.addEventListener('pointerup', flowDragUp);
        return;
    }
    if (gnode) {
        flowSelect(gnode.dataset.id === '__trigger' ? '__trigger' : gnode.dataset.id);
        return;
    }
    // pan
    e.preventDefault();
    fxDrag = { pan: true, sx: e.clientX, sy: e.clientY, ox: fxView.panX, oy: fxView.panY };
    const wrap = document.getElementById('fx-canvas-wrap');
    if (wrap) wrap.classList.add('is-panning');
    window.addEventListener('pointermove', flowDragMove);
    window.addEventListener('pointerup', flowDragUp);
}
function flowDragMove(e) {
    if (!fxDrag) return;
    if (fxDrag.pan) {
        fxView.panX = fxDrag.ox + (e.clientX - fxDrag.sx);
        fxView.panY = fxDrag.oy + (e.clientY - fxDrag.sy);
        flowApplyTransform(); flowDrawEdges();
        return;
    }
    const dx = (e.clientX - fxDrag.sx) / fxView.zoom;
    const dy = (e.clientY - fxDrag.sy) / fxView.zoom;
    if (Math.abs(dx) + Math.abs(dy) > 2) fxDrag.moved = true;
    fxDrag.obj.x = Math.round(fxDrag.ox + dx);
    fxDrag.obj.y = Math.round(fxDrag.oy + dy);
    const el = document.querySelector(`.fx-gnode[data-id="${fxDrag.id}"]`);
    if (el) { el.style.left = fxDrag.obj.x + 'px'; el.style.top = fxDrag.obj.y + 'px'; }
    flowDrawEdges();
}
function flowDragUp() {
    const wrap = document.getElementById('fx-canvas-wrap');
    if (wrap) wrap.classList.remove('is-panning');
    if (fxDrag && !fxDrag.pan && !fxDrag.moved) flowSelect(fxDrag.id);
    fxDrag = null;
    window.removeEventListener('pointermove', flowDragMove);
    window.removeEventListener('pointerup', flowDragUp);
}
function flowConnMove(e) {
    if (!fxConn) return;
    fxConn.moved = true;
    const canvas = document.getElementById('fx-canvas');
    const cr = canvas.getBoundingClientRect();
    const p2 = { x: (e.clientX - cr.left) / fxView.zoom, y: (e.clientY - cr.top) / fxView.zoom };
    fxConn.tmp.setAttribute('d', flowEdgePath(fxConn.p1, p2));
}
function flowConnUp(e) {
    window.removeEventListener('pointermove', flowConnMove);
    window.removeEventListener('pointerup', flowConnUp);
    if (!fxConn) return;
    if (fxConn.tmp) fxConn.tmp.remove();
    const tgt = document.elementFromPoint(e.clientX, e.clientY);
    const gnode = tgt && tgt.closest ? tgt.closest('.fx-gnode') : null;
    if (gnode) {
        const toId = gnode.dataset.id;
        if (toId && toId !== '__trigger' && toId !== fxConn.from) {
            if (fxConn.from === '__trigger') flowDraft.graph.start = toId;
            else { const n = flowDraft.graph.nodes.find(x => x.id === fxConn.from); if (n) n[fxConn.slot] = toId; }
            flowRenderNodes(); flowDrawEdges();
        }
    }
    fxConn = null;
}

/* ---------------- drawer (config) ---------------- */
function flowSelect(id) {
    fxSelected = id;
    document.querySelectorAll('.fx-gnode').forEach(el => el.classList.toggle('is-sel', el.dataset.id === id));
    renderFlowDrawer();
}
function renderFlowDrawer() {
    const box = document.getElementById('fx-drawer');
    if (!box || !flowDraft) return;
    const g = flowDraft.graph;

    if (fxSelected === '__trigger') {
        const t = g.trigger;
        let cfg = '<div class="fx-mini">Dispara na primeira mensagem que o lead enviar.</div>';
        if (t.type === 'entrou_coluna') cfg = `<label>Coluna do Kanban <select onchange="flowSetTrigger('coluna', this.value)"><option value="">—</option>${flowColOptions(t.config.coluna)}</select></label>`;
        else if (t.type === 'palavra_chave') cfg = `<label>Palavras-chave <span class="fx-mini">separadas por vírgula</span><input type="text" value="${escapeHtml(t.config.palavras || '')}" oninput="flowSetTrigger('palavras', this.value)"></label>`;
        box.innerHTML = `
            <div class="fx-drawer-head"><i class="fa-solid fa-bolt"></i> Gatilho</div>
            <label>Quando iniciar
                <select onchange="flowSetTrigger('type', this.value)">
                    <option value="primeira_mensagem" ${t.type === 'primeira_mensagem' ? 'selected' : ''}>Primeira mensagem do lead</option>
                    <option value="entrou_coluna" ${t.type === 'entrou_coluna' ? 'selected' : ''}>Mensagem com o lead numa coluna</option>
                    <option value="palavra_chave" ${t.type === 'palavra_chave' ? 'selected' : ''}>Mensagem contém palavra-chave</option>
                </select>
            </label>
            ${cfg}
            <label>Primeiro passo <select onchange="flowSetStart(this.value)">${flowNodeTargetOptions(g.start, '__trigger')}</select></label>`;
        return;
    }

    const n = g.nodes.find(x => x.id === fxSelected);
    if (!n) {
        box.innerHTML = `
            <div class="fx-drawer-head"><i class="fa-solid fa-vial"></i> Simular</div>
            <p class="fx-mini">Uma mensagem de teste por linha (a 1ª dispara o gatilho). Não envia nada no WhatsApp.</p>
            <textarea id="fx-sim-input" rows="4" placeholder="oi&#10;quero saber o preço"></textarea>
            <button class="btn-cancel" style="width:100%" onclick="flowSimulate()"><i class="fa-solid fa-play"></i> Rodar simulação</button>
            <div id="fx-sim-log" class="fx-sim-log"></div>
            <p class="fx-mini" style="margin-top:1rem">Clique num passo para editar. Arraste dos pontinhos para ligar passos; clique numa linha para desligar.</p>`;
        return;
    }

    const def = FLOW_NODE_DEFS[n.type] || FLOW_NODE_DEFS.fim;
    box.innerHTML = `
        <div class="fx-drawer-head">
            <span><i class="fa-solid ${def.icon}"></i> ${escapeHtml(def.label)} <span class="fx-mini">(${n.id})</span></span>
            <button class="fx-drawer-del" onclick="flowRemoveNode('${n.id}')" title="Remover passo"><i class="fa-solid fa-trash"></i></button>
        </div>
        <label>Tipo do passo
            <select onchange="flowSetNode('${n.id}', 'type', this.value)">
                ${Object.entries(FLOW_NODE_DEFS).map(([k, v]) => `<option value="${k}" ${n.type === k ? 'selected' : ''}>${v.label}</option>`).join('')}
            </select>
        </label>
        ${flowNodeFields(n)}
        ${def.ports.length ? `<div class="fx-drawer-sub">Ligações</div>${def.ports.map(p => `
            <label>${FLOW_TRANS_LABEL[p.slot] || p.slot}
                <select onchange="flowSetNode('${n.id}', '${p.slot}', this.value)">${flowNodeTargetOptions(n[p.slot], n.id)}</select>
            </label>`).join('')}` : '<div class="fx-mini fx-drawer-sub">Este passo encerra o fluxo.</div>'}`;
}

function flowNodeFields(n) {
    const c = n.config || {};
    const v = (x) => escapeHtml(x == null ? '' : String(x));
    switch (n.type) {
        case 'enviar_texto':
            return `<label>Texto <span class="fx-mini">variáveis: {{nome}}, {{telefone}}</span>
                <textarea rows="3" oninput="flowSetNode('${n.id}', 'config.texto', this.value)">${v(c.texto)}</textarea></label>`;
        case 'aguardar_resposta':
            return `<label>Expira em (minutos) <span class="fx-mini">vazio = sem limite</span>
                <input type="number" min="1" value="${v(c.timeout_min)}" oninput="flowSetNode('${n.id}', 'config.timeout_min', this.value)"></label>`;
        case 'delay':
            return `<label>Esperar (minutos)
                <input type="number" min="1" value="${v(c.minutos || 5)}" oninput="flowSetNode('${n.id}', 'config.minutos', this.value)"></label>`;
        case 'condicao':
            return `<label>Comparar a última resposta
                <select onchange="flowSetNode('${n.id}', 'config.modo', this.value)">
                    ${[['contem', 'contém'], ['igual', 'igual a'], ['comeca_com', 'começa com'], ['regex', 'regex']]
                        .map(([k, lbl]) => `<option value="${k}" ${(c.modo || 'contem') === k ? 'selected' : ''}>${lbl}</option>`).join('')}
                </select></label>
                <label>Valor <input type="text" value="${v(c.valor)}" oninput="flowSetNode('${n.id}', 'config.valor', this.value)"></label>`;
        case 'mover_coluna':
            return `<label>Coluna do Kanban <select onchange="flowSetNode('${n.id}', 'config.coluna', this.value)"><option value="">—</option>${flowColOptions(c.coluna)}</select></label>`;
        case 'adicionar_tag':
            return `<label>Etiqueta <input type="text" value="${v(c.tag)}" oninput="flowSetNode('${n.id}', 'config.tag', this.value)"></label>`;
        case 'definir_ia':
            return `<label>Agente de IA para esse lead
                <select onchange="flowSetNode('${n.id}', 'config.ligada', this.value === '1')">
                    <option value="0" ${!c.ligada ? 'selected' : ''}>Desligar</option>
                    <option value="1" ${c.ligada ? 'selected' : ''}>Ligar</option>
                </select></label>`;
        case 'handoff':
            return `<label>Motivo <span class="fx-mini">aparece na notificação da equipe</span>
                <input type="text" value="${v(c.motivo)}" oninput="flowSetNode('${n.id}', 'config.motivo', this.value)"></label>`;
        default:
            return '';
    }
}

/* ---------------- salvar / excluir / simular ---------------- */
async function flowSave() {
    if (!flowDraft) return;
    try {
        const r = await fetch('/api/flows/' + flowDraft.id, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome: flowDraft.nome, ativo: flowDraft.ativo ? 1 : 0, prioridade: flowDraft.prioridade, graph: flowDraft.graph }),
        });
        const j = await r.json();
        if (!r.ok) { showToast(j.error || 'Erro ao salvar.', 'danger'); return; }
        flowDraft.version = j.version;
        showToast('Fluxo salvo.', 'success');
        await loadFlows();
    } catch (e) { showToast('Erro ao salvar fluxo.', 'danger'); }
}
async function flowDelete() {
    if (!flowDraft) return;
    const ok = typeof customConfirm === 'function'
        ? await customConfirm('Excluir este fluxo? Execuções em andamento serão interrompidas.', 'Excluir fluxo')
        : confirm('Excluir este fluxo?');
    if (!ok) return;
    try {
        const r = await fetch('/api/flows/' + flowDraft.id, { method: 'DELETE' });
        if (!r.ok) { const j = await r.json().catch(() => ({})); showToast(j.error || 'Erro ao excluir.', 'danger'); return; }
        flowDraft = null;
        const ed = document.getElementById('fx-editor');
        if (ed) ed.innerHTML = '<div class="fx-empty"><i class="fa-solid fa-diagram-project"></i><span>Selecione um fluxo à esquerda ou crie um novo.</span></div>';
        await loadFlows();
    } catch (e) { showToast('Erro ao excluir fluxo.', 'danger'); }
}
async function flowSimulate() {
    if (!flowDraft) return;
    const logBox = document.getElementById('fx-sim-log');
    const raw = (document.getElementById('fx-sim-input') || {}).value || '';
    const messages = raw.split('\n').map(s => s.trim()).filter(Boolean);
    logBox.innerHTML = '<span class="fx-mini">rodando…</span>';
    try {
        const r = await fetch('/api/flows/simulate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ graph: flowDraft.graph, messages }),
        });
        const j = await r.json();
        if (!r.ok) { logBox.innerHTML = `<div class="fx-sim-err">${escapeHtml(j.error || 'Erro')}</div>`; return; }
        const lines = (j.log || []).map(l => {
            if (l.info) return `<div class="fx-sim-line fx-sim-info">${escapeHtml(l.info)}</div>`;
            if (l.aviso) return `<div class="fx-sim-line fx-sim-err">${escapeHtml(l.aviso)}</div>`;
            const det = Object.entries(l).filter(([k]) => k !== 'node' && k !== 'tipo').map(([k, val]) => `${k}: ${escapeHtml(String(val))}`).join(' · ');
            const label = (FLOW_NODE_DEFS[l.tipo] && FLOW_NODE_DEFS[l.tipo].label) || l.tipo || '';
            return `<div class="fx-sim-line"><b>${escapeHtml(l.node || '')}</b> ${escapeHtml(label)}${det ? ` <span class="fx-mini">— ${det}</span>` : ''}</div>`;
        });
        logBox.innerHTML = lines.join('') || '<span class="fx-mini">(nenhuma ação)</span>';
    } catch (e) { logBox.innerHTML = '<div class="fx-sim-err">Erro na simulação.</div>'; }
}

/* ============================================================================
   FOLLOW-UP AUTOMÁTICO (cadência global) — config na mesma tela de Fluxos
   ========================================================================== */
let fuCfg = null;
const FU_DOW = [['1', 'Seg'], ['2', 'Ter'], ['3', 'Qua'], ['4', 'Qui'], ['5', 'Sex'], ['6', 'Sáb'], ['0', 'Dom']];

async function flowOpenFollowup() {
    try {
        const r = await fetch('/api/followup/config').then(x => x.json());
        fuCfg = r.config || {};
    } catch (e) { showToast('Erro ao carregar follow-up.', 'danger'); return; }
    if (!Array.isArray(fuCfg.steps)) fuCfg.steps = [];
    if (!Array.isArray(fuCfg.aplicar_colunas)) fuCfg.aplicar_colunas = [];
    if (!Array.isArray(fuCfg.parar_em_colunas)) fuCfg.parar_em_colunas = ['col-ganho'];
    if (!Array.isArray(fuCfg.dias_semana)) fuCfg.dias_semana = [1, 2, 3, 4, 5, 6];
    flowDraft = null;
    renderFlowList();
    renderFollowupEditor();
}

function fuMinToLabel(m) {
    m = parseInt(m, 10) || 0;
    if (m % 1440 === 0) return (m / 1440) + ' dia(s)';
    if (m % 60 === 0) return (m / 60) + ' h';
    return m + ' min';
}
function fuSetStep(i, key, val) {
    if (!fuCfg.steps[i]) return;
    if (key === 'atraso_min') {
        fuCfg.steps[i][key] = Math.max(1, parseInt(val, 10) || 1);
        const el = document.getElementById('fu-step-lbl-' + i);
        if (el) el.textContent = fuMinToLabel(fuCfg.steps[i].atraso_min) + ' após a última mensagem';
    } else if (key === 'so_horario_comercial') {
        fuCfg.steps[i][key] = !!val;
    } else {
        fuCfg.steps[i][key] = val;
    }
}
function fuAddStep() {
    const last = fuCfg.steps[fuCfg.steps.length - 1];
    fuCfg.steps.push({ atraso_min: last ? last.atraso_min * 2 : 180, texto: '', template_name: '', so_horario_comercial: true });
    renderFollowupEditor();
}
function fuRemoveStep(i) { fuCfg.steps.splice(i, 1); renderFollowupEditor(); }
function fuToggleCol(list, col, on) {
    const arr = fuCfg[list];
    const idx = arr.indexOf(col);
    if (on && idx < 0) arr.push(col);
    if (!on && idx >= 0) arr.splice(idx, 1);
}
function fuToggleDow(d, on) { fuToggleCol('dias_semana', parseInt(d, 10), on); }

function renderFollowupEditor() {
    const box = document.getElementById('fx-editor');
    if (!box || !fuCfg) return;
    const c = fuCfg;
    const cols = flowCols();

    const stepsHtml = c.steps.map((s, i) => `
        <div class="fx-node" style="margin-bottom:0.6rem">
            <div class="fx-node-head" style="cursor:default">
                <span class="fx-node-id" style="min-width:auto">Lembrete ${i + 1}</span>
                <span class="fx-mini" id="fu-step-lbl-${i}" style="flex:1">${fuMinToLabel(s.atraso_min)} após a última mensagem</span>
                <button class="fx-drawer-del" onclick="fuRemoveStep(${i})" title="Remover"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="fx-node-body" style="padding:0.7rem">
                <label>Enviar após (minutos)
                    <input type="number" min="1" value="${s.atraso_min}" oninput="fuSetStep(${i}, 'atraso_min', this.value)">
                </label>
                <label>Mensagem <span class="fx-mini">variáveis: {{nome}}</span>
                    <textarea rows="2" oninput="fuSetStep(${i}, 'texto', this.value)">${escapeHtml(s.texto || '')}</textarea>
                </label>
                <label style="display:flex;align-items:center;gap:0.4rem;font-weight:500">
                    <input type="checkbox" style="width:auto;margin:0" ${s.so_horario_comercial ? 'checked' : ''} onchange="fuSetStep(${i}, 'so_horario_comercial', this.checked)">
                    Só enviar em horário comercial
                </label>
            </div>
        </div>`).join('') || '<div class="fx-mini">Nenhum lembrete. Adicione o primeiro.</div>';

    const colChecks = (list) => Object.entries(cols).map(([k, v]) =>
        `<label style="display:flex;align-items:center;gap:0.3rem;font-weight:500;margin:0">
            <input type="checkbox" style="width:auto;margin:0" ${c[list].includes(k) ? 'checked' : ''} onchange="fuToggleCol('${list}', '${k}', this.checked)"> ${escapeHtml(v.label || k)}</label>`).join('');

    box.innerHTML = `
        <div class="fx-editor-head">
            <div style="flex:1">
                <b style="font-size:0.95rem"><i class="fa-solid fa-clock-rotate-left"></i> Follow-up automático</b>
                <div class="fx-mini">Lembra o lead quando ele para de responder. Para na hora em que ele responde.</div>
            </div>
            <label class="fx-switch"><input type="checkbox" ${c.ativo ? 'checked' : ''} onchange="fuCfg.ativo = this.checked"> Ativo</label>
            <button class="btn-save" onclick="flowSaveFollowup()"><i class="fa-solid fa-floppy-disk"></i> Salvar</button>
        </div>

        <div class="fx-block">
            <div class="fx-block-title"><i class="fa-solid fa-list-ol"></i> Lembretes (em cascata)</div>
            ${stepsHtml}
            <button class="fx-add-btn" onclick="fuAddStep()"><i class="fa-solid fa-plus"></i> Adicionar lembrete</button>
            <div class="fx-mini" style="margin-top:0.6rem">O tempo conta a partir da <b>última mensagem que você enviou</b>. Fora da janela de 24h do WhatsApp o lembrete é pulado (envio por template fica pra próxima fase).</div>
        </div>

        <div class="fx-block">
            <div class="fx-block-title"><i class="fa-solid fa-filter"></i> Onde aplicar</div>
            <label>Colunas do Kanban <span class="fx-mini">nenhuma marcada = todas, menos as de parada</span></label>
            <div style="display:flex;flex-wrap:wrap;gap:0.5rem;margin:0.3rem 0 0.9rem">${colChecks('aplicar_colunas')}</div>
            <label>Parar quando o lead entrar em <span class="fx-mini">(a coluna de lead fechado sempre para)</span></label>
            <div style="display:flex;flex-wrap:wrap;gap:0.5rem;margin:0.3rem 0 0.9rem">${colChecks('parar_em_colunas')}</div>
            <label style="display:flex;align-items:center;gap:0.4rem;font-weight:500">
                <input type="checkbox" style="width:auto;margin:0" ${c.aplicar_com_humano ? 'checked' : ''} onchange="fuCfg.aplicar_com_humano = this.checked">
                Aplicar mesmo em conversas assumidas por um atendente
            </label>
        </div>

        <div class="fx-block">
            <div class="fx-block-title"><i class="fa-solid fa-clock"></i> Horário permitido</div>
            <div class="fx-row">
                <label>Silêncio a partir de <input type="time" value="${escapeHtml(c.quiet_start || '20:00')}" oninput="fuCfg.quiet_start = this.value"></label>
                <label>Volta a enviar às <input type="time" value="${escapeHtml(c.quiet_end || '08:00')}" oninput="fuCfg.quiet_end = this.value"></label>
            </div>
            <label>Dias da semana</label>
            <div style="display:flex;flex-wrap:wrap;gap:0.5rem;margin-top:0.3rem">
                ${FU_DOW.map(([d, lbl]) => `<label style="display:flex;align-items:center;gap:0.3rem;font-weight:500;margin:0">
                    <input type="checkbox" style="width:auto;margin:0" ${c.dias_semana.includes(parseInt(d, 10)) ? 'checked' : ''} onchange="fuToggleDow('${d}', this.checked)"> ${lbl}</label>`).join('')}
            </div>
        </div>

        <div class="fx-block">
            <div class="fx-block-title"><i class="fa-solid fa-flag-checkered"></i> Ao esgotar os lembretes</div>
            <label>Ação final
                <select onchange="fuCfg.acao_final = this.value">
                    <option value="nada" ${c.acao_final === 'nada' ? 'selected' : ''}>Não fazer nada</option>
                    <option value="mover:col-perdido" ${c.acao_final === 'mover:col-perdido' ? 'selected' : ''}>Mover o lead para "${escapeHtml((cols['col-perdido'] && cols['col-perdido'].label) || 'Perdido')}"</option>
                    <option value="tag:sem-resposta" ${c.acao_final === 'tag:sem-resposta' ? 'selected' : ''}>Adicionar etiqueta "sem-resposta"</option>
                </select>
            </label>
        </div>`;
}

async function flowSaveFollowup() {
    if (!fuCfg) return;
    try {
        const r = await fetch('/api/followup/config', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fuCfg),
        });
        const j = await r.json();
        if (!r.ok) { showToast(j.error || 'Erro ao salvar.', 'danger'); return; }
        fuCfg = j.config;
        showToast('Follow-up salvo.', 'success');
    } catch (e) { showToast('Erro ao salvar follow-up.', 'danger'); }
}
