/* ============================================================================
   FLUXOS DE ATENDIMENTO (nodes) — editor
   Um fluxo é um grafo: um GATILHO + uma lista de PASSOS ligados por transições
   ("próximo passo", "se SIM/NÃO", "se expirar"). O backend (api-server.js) roda
   esse grafo quando chega mensagem no WhatsApp, ANTES do agente de IA.
   Vanilla JS, sem framework — segue o padrão do resto do sistema.
   ========================================================================== */

const FLOW_NODE_DEFS = {
    enviar_texto:      { label: 'Enviar mensagem',            trans: ['next'] },
    aguardar_resposta: { label: 'Aguardar resposta do lead',  trans: ['next', 'on_timeout'] },
    condicao:          { label: 'Condição (SE / SENÃO)',      trans: ['on_true', 'on_false'] },
    delay:             { label: 'Esperar um tempo',           trans: ['next'] },
    mover_coluna:      { label: 'Mover no Kanban',            trans: ['next'] },
    adicionar_tag:     { label: 'Adicionar etiqueta',         trans: ['next'] },
    definir_ia:        { label: 'Ligar / desligar a IA',      trans: ['next'] },
    entregar_ia:       { label: 'Entregar para o agente de IA', trans: [] },
    handoff:           { label: 'Passar para atendente humano', trans: [] },
    fim:               { label: 'Fim do fluxo',               trans: [] },
};

const FLOW_TRANS_LABEL = {
    next: 'Próximo passo',
    on_timeout: 'Se expirar',
    on_true: 'Se SIM',
    on_false: 'Se NÃO',
};

let flowList = [];
let flowDraft = null;      // { id, nome, ativo, prioridade, version, graph:{trigger, nodes} }
let flowNodeSeq = 0;

function flowIsAdmin() {
    return typeof loggedUser !== 'undefined' && loggedUser &&
        (loggedUser.role === 'admin' || loggedUser.username === 'admin');
}

function flowCols() {
    if (typeof KANBAN_COLUMNS !== 'undefined' && KANBAN_COLUMNS) return KANBAN_COLUMNS;
    return {
        'col-entrada': { label: 'Entrada' }, 'col-contatado': { label: 'Contatado' },
        'col-orcado': { label: 'Orçado' }, 'col-agendado': { label: 'Agendado' },
        'col-ganho': { label: 'Ganho' }, 'col-perdido': { label: 'Perdido' },
    };
}
function flowColOptions(sel) {
    return Object.entries(flowCols())
        .map(([k, v]) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${escapeHtml(v.label || k)}</option>`)
        .join('');
}
function flowNodeTargetOptions(sel, excludeId) {
    const opts = (flowDraft.graph.nodes || [])
        .filter(n => n.id !== excludeId)
        .map(n => `<option value="${n.id}" ${sel === n.id ? 'selected' : ''}>${n.id} · ${FLOW_NODE_DEFS[n.type] ? FLOW_NODE_DEFS[n.type].label : n.type}</option>`)
        .join('');
    return `<option value="">— fim —</option>${opts}`;
}

/* ---------- carregar / listar ---------- */
async function loadFlows() {
    try {
        const r = await fetch('/api/flows').then(x => x.json());
        flowList = r.flows || [];
    } catch (e) {
        flowList = [];
    }
    renderFlowList();
}

function renderFlowList() {
    const box = document.getElementById('fx-list');
    if (!box) return;
    if (!flowList.length) {
        box.innerHTML = '<div class="fx-list-empty">Nenhum fluxo ainda.</div>';
        return;
    }
    box.innerHTML = flowList.map(f => `
        <button class="fx-list-item ${flowDraft && flowDraft.id === f.id ? 'is-active' : ''}" onclick="flowOpen('${f.id}')">
            <span class="fx-dot ${f.ativo ? 'on' : ''}"></span>
            <span class="fx-list-name">${escapeHtml(f.nome || 'Sem nome')}</span>
            ${f.ativo ? '<span class="fx-badge">ativo</span>' : ''}
        </button>
    `).join('');
}

async function flowNew() {
    if (!flowIsAdmin()) { showToast('Apenas administradores criam fluxos.', 'danger'); return; }
    try {
        const r = await fetch('/api/flows', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome: 'Novo fluxo' }),
        });
        const j = await r.json();
        if (!r.ok) { showToast(j.error || 'Erro ao criar.', 'danger'); return; }
        await loadFlows();
        flowOpen(j.id);
    } catch (e) {
        showToast('Erro ao criar fluxo.', 'danger');
    }
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
        flowDraft = {
            id: f.id, nome: f.nome || 'Sem nome', ativo: !!f.ativo,
            prioridade: f.prioridade || 0, version: f.version || 1, graph,
        };
        flowNodeSeq = graph.nodes.reduce((m, n) => {
            const num = parseInt(String(n.id).replace(/\D/g, ''), 10) || 0;
            return Math.max(m, num);
        }, 0);
        renderFlowList();
        renderFlowEditor();
    } catch (e) {
        showToast('Erro ao abrir fluxo.', 'danger');
    }
}

/* ---------- mutações do grafo ---------- */
function flowNewNodeId() { flowNodeSeq += 1; return 'n' + flowNodeSeq; }

function flowAddNode() {
    const nodes = flowDraft.graph.nodes;
    const id = flowNewNodeId();
    const prev = nodes[nodes.length - 1];
    nodes.push({ id, type: 'enviar_texto', config: {}, next: null });
    if (prev && FLOW_NODE_DEFS[prev.type] && FLOW_NODE_DEFS[prev.type].trans.includes('next') && !prev.next) {
        prev.next = id;
    }
    renderFlowEditor();
}

function flowRemoveNode(id) {
    const g = flowDraft.graph;
    g.nodes = g.nodes.filter(n => n.id !== id);
    g.nodes.forEach(n => {
        ['next', 'on_true', 'on_false', 'on_timeout'].forEach(k => { if (n[k] === id) n[k] = null; });
    });
    renderFlowEditor();
}

function flowMoveNode(id, dir) {
    const arr = flowDraft.graph.nodes;
    const i = arr.findIndex(n => n.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    renderFlowEditor();
}

function flowSetTrigger(field, value) {
    const t = flowDraft.graph.trigger;
    if (field === 'type') { t.type = value; t.config = {}; renderFlowEditor(); return; }
    t.config[field] = value;
}

function flowSetNode(id, path, value) {
    const n = flowDraft.graph.nodes.find(x => x.id === id);
    if (!n) return;
    if (path === 'type') {
        n.type = value;
        n.config = {};
        delete n.on_true; delete n.on_false; delete n.on_timeout;
        if (!('next' in n)) n.next = null;
        renderFlowEditor();
        return;
    }
    if (path.indexOf('config.') === 0) { n.config[path.slice(7)] = value; return; }
    n[path] = value || null;
}

/* ---------- render do editor ---------- */
function renderFlowEditor() {
    const box = document.getElementById('fx-editor');
    if (!box || !flowDraft) return;
    const d = flowDraft;
    const t = d.graph.trigger;

    let triggerCfg = '<div class="fx-mini">Dispara na primeira mensagem que o lead enviar.</div>';
    if (t.type === 'entrou_coluna') {
        triggerCfg = `<label>Coluna do Kanban
            <select onchange="flowSetTrigger('coluna', this.value)"><option value="">—</option>${flowColOptions(t.config.coluna)}</select>
        </label>`;
    } else if (t.type === 'palavra_chave') {
        triggerCfg = `<label>Palavras-chave <span class="fx-mini">separadas por vírgula</span>
            <input type="text" value="${escapeHtml(t.config.palavras || '')}" oninput="flowSetTrigger('palavras', this.value)">
        </label>`;
    }

    const nodesHtml = d.graph.nodes.length
        ? d.graph.nodes.map(n => flowNodeCard(n)).join('')
        : '<div class="fx-mini">Nenhum passo ainda. Adicione o primeiro abaixo.</div>';

    box.innerHTML = `
        <div class="fx-editor-head">
            <input class="fx-name-input" value="${escapeHtml(d.nome)}" oninput="flowDraft.nome = this.value" placeholder="Nome do fluxo">
            <div class="fx-editor-actions">
                <label class="fx-switch"><input type="checkbox" ${d.ativo ? 'checked' : ''} onchange="flowDraft.ativo = this.checked"> Ativo</label>
                <label class="fx-mini">Prioridade
                    <input type="number" style="width:52px" value="${d.prioridade}" oninput="flowDraft.prioridade = parseInt(this.value, 10) || 0">
                </label>
                <button class="btn-cancel" onclick="flowDelete()" title="Excluir fluxo"><i class="fa-solid fa-trash"></i></button>
                <button class="btn-save" onclick="flowSave()"><i class="fa-solid fa-floppy-disk"></i> Salvar</button>
            </div>
        </div>

        <div class="fx-block">
            <div class="fx-block-title"><i class="fa-solid fa-bolt"></i> Gatilho</div>
            <label>Quando iniciar o fluxo
                <select onchange="flowSetTrigger('type', this.value)">
                    <option value="primeira_mensagem" ${t.type === 'primeira_mensagem' ? 'selected' : ''}>Primeira mensagem do lead</option>
                    <option value="entrou_coluna" ${t.type === 'entrou_coluna' ? 'selected' : ''}>Mensagem com o lead numa coluna</option>
                    <option value="palavra_chave" ${t.type === 'palavra_chave' ? 'selected' : ''}>Mensagem contém palavra-chave</option>
                </select>
            </label>
            ${triggerCfg}
        </div>

        <div class="fx-block">
            <div class="fx-block-title"><i class="fa-solid fa-list-ol"></i> Passos</div>
            <div id="fx-nodes">${nodesHtml}</div>
            <button class="fx-add-btn" onclick="flowAddNode()"><i class="fa-solid fa-plus"></i> Adicionar passo</button>
        </div>

        <div class="fx-block">
            <div class="fx-block-title"><i class="fa-solid fa-vial"></i> Simular</div>
            <p class="fx-mini">Uma mensagem de teste por linha (a 1ª dispara o gatilho). Não envia nada no WhatsApp nem altera o lead.</p>
            <textarea id="fx-sim-input" rows="3" placeholder="oi&#10;quero saber o preço"></textarea>
            <button class="btn-cancel" onclick="flowSimulate()"><i class="fa-solid fa-play"></i> Rodar simulação</button>
            <div id="fx-sim-log" class="fx-sim-log"></div>
        </div>
    `;
}

function flowNodeCard(n) {
    return `<div class="fx-node">
        <div class="fx-node-head">
            <span class="fx-node-id">${n.id}</span>
            <select class="fx-node-type" onchange="flowSetNode('${n.id}', 'type', this.value)">
                ${Object.entries(FLOW_NODE_DEFS).map(([k, v]) => `<option value="${k}" ${n.type === k ? 'selected' : ''}>${v.label}</option>`).join('')}
            </select>
            <span class="fx-node-move">
                <button onclick="flowMoveNode('${n.id}', -1)" title="Subir"><i class="fa-solid fa-arrow-up"></i></button>
                <button onclick="flowMoveNode('${n.id}', 1)" title="Descer"><i class="fa-solid fa-arrow-down"></i></button>
                <button class="fx-node-del" onclick="flowRemoveNode('${n.id}')" title="Remover"><i class="fa-solid fa-xmark"></i></button>
            </span>
        </div>
        <div class="fx-node-body">
            ${flowNodeFields(n)}
            ${flowNodeTransitions(n)}
        </div>
    </div>`;
}

function flowNodeFields(n) {
    const c = n.config || {};
    const v = (x) => escapeHtml(x == null ? '' : String(x));
    switch (n.type) {
        case 'enviar_texto':
            return `<label>Texto <span class="fx-mini">variáveis: {{nome}}, {{telefone}}</span>
                <textarea rows="3" oninput="flowSetNode('${n.id}', 'config.texto', this.value)">${v(c.texto)}</textarea>
            </label>`;
        case 'aguardar_resposta':
            return `<label>Expira em (minutos) <span class="fx-mini">vazio = sem limite</span>
                <input type="number" min="1" value="${v(c.timeout_min)}" oninput="flowSetNode('${n.id}', 'config.timeout_min', this.value)">
            </label>`;
        case 'delay':
            return `<label>Esperar (minutos)
                <input type="number" min="1" value="${v(c.minutos || 5)}" oninput="flowSetNode('${n.id}', 'config.minutos', this.value)">
            </label>`;
        case 'condicao':
            return `<div class="fx-row">
                <label>Comparar a última resposta
                    <select onchange="flowSetNode('${n.id}', 'config.modo', this.value)">
                        ${[['contem', 'contém'], ['igual', 'igual a'], ['comeca_com', 'começa com'], ['regex', 'regex']]
                            .map(([k, lbl]) => `<option value="${k}" ${(c.modo || 'contem') === k ? 'selected' : ''}>${lbl}</option>`).join('')}
                    </select>
                </label>
                <label>Valor
                    <input type="text" value="${v(c.valor)}" oninput="flowSetNode('${n.id}', 'config.valor', this.value)">
                </label>
            </div>`;
        case 'mover_coluna':
            return `<label>Coluna do Kanban
                <select onchange="flowSetNode('${n.id}', 'config.coluna', this.value)"><option value="">—</option>${flowColOptions(c.coluna)}</select>
            </label>`;
        case 'adicionar_tag':
            return `<label>Etiqueta
                <input type="text" value="${v(c.tag)}" oninput="flowSetNode('${n.id}', 'config.tag', this.value)">
            </label>`;
        case 'definir_ia':
            return `<label>Agente de IA para esse lead
                <select onchange="flowSetNode('${n.id}', 'config.ligada', this.value === '1')">
                    <option value="0" ${!c.ligada ? 'selected' : ''}>Desligar</option>
                    <option value="1" ${c.ligada ? 'selected' : ''}>Ligar</option>
                </select>
            </label>`;
        case 'handoff':
            return `<label>Motivo <span class="fx-mini">aparece na notificação para a equipe</span>
                <input type="text" value="${v(c.motivo)}" oninput="flowSetNode('${n.id}', 'config.motivo', this.value)">
            </label>`;
        default:
            return '';
    }
}

function flowNodeTransitions(n) {
    const def = FLOW_NODE_DEFS[n.type];
    if (!def || !def.trans.length) return '<div class="fx-mini fx-node-end">Este passo encerra o fluxo.</div>';
    return `<div class="fx-row">${def.trans.map(k => `
        <label>${FLOW_TRANS_LABEL[k]}
            <select onchange="flowSetNode('${n.id}', '${k}', this.value)">${flowNodeTargetOptions(n[k], n.id)}</select>
        </label>`).join('')}</div>`;
}

/* ---------- salvar / excluir / simular ---------- */
async function flowSave() {
    if (!flowDraft) return;
    try {
        const r = await fetch('/api/flows/' + flowDraft.id, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nome: flowDraft.nome,
                ativo: flowDraft.ativo ? 1 : 0,
                prioridade: flowDraft.prioridade,
                graph: flowDraft.graph,
            }),
        });
        const j = await r.json();
        if (!r.ok) { showToast(j.error || 'Erro ao salvar.', 'danger'); return; }
        flowDraft.version = j.version;
        showToast('Fluxo salvo.', 'success');
        await loadFlows();
    } catch (e) {
        showToast('Erro ao salvar fluxo.', 'danger');
    }
}

async function flowDelete() {
    if (!flowDraft) return;
    const ok = typeof customConfirm === 'function'
        ? await customConfirm('Excluir este fluxo? Execuções em andamento serão interrompidas.', 'Excluir fluxo')
        : confirm('Excluir este fluxo?');
    if (!ok) return;
    try {
        const r = await fetch('/api/flows/' + flowDraft.id, { method: 'DELETE' });
        if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            showToast(j.error || 'Erro ao excluir.', 'danger');
            return;
        }
        flowDraft = null;
        const ed = document.getElementById('fx-editor');
        if (ed) ed.innerHTML = '<div class="fx-empty"><i class="fa-solid fa-diagram-project"></i><span>Selecione um fluxo à esquerda ou crie um novo.</span></div>';
        await loadFlows();
    } catch (e) {
        showToast('Erro ao excluir fluxo.', 'danger');
    }
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
            const det = Object.entries(l)
                .filter(([k]) => k !== 'node' && k !== 'tipo')
                .map(([k, val]) => `${k}: ${escapeHtml(String(val))}`)
                .join(' · ');
            const label = (FLOW_NODE_DEFS[l.tipo] && FLOW_NODE_DEFS[l.tipo].label) || l.tipo || '';
            return `<div class="fx-sim-line"><b>${escapeHtml(l.node || '')}</b> ${escapeHtml(label)}${det ? ` <span class="fx-mini">— ${det}</span>` : ''}</div>`;
        });
        logBox.innerHTML = lines.join('') || '<span class="fx-mini">(nenhuma ação)</span>';
    } catch (e) {
        logBox.innerHTML = '<div class="fx-sim-err">Erro na simulação.</div>';
    }
}
