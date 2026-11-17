// Perfis de follow-up — cada tipo de lead com a sua própria cadência. Só lógica
// pura (sem banco, sem rede), testada em test/followup-perfis.test.mjs.
//
// Decisão da clínica (17/11/2026):
// - O lead de estética e o lead do Dr. Julimar têm perfis diferentes, então cada
//   um recebe uma sequência de lembretes diferente quando para de responder.
// - Quem decide o tipo é uma ETIQUETA no lead. A IA do WhatsApp coloca sozinha
//   ("Estética" ou "Dr. Julimar") assim que fica claro o interesse; a equipe
//   corrige trocando a etiqueta no card.
// - O funil é uma regra extra: lead num funil ligado a um perfil segue esse
//   perfil mesmo sem etiqueta.
// - Lead que não se encaixa em nenhum perfil ativo segue a cadência padrão (a
//   que já existia). Horário de silêncio, dias da semana, colunas onde aplicar
//   e as paradas (respondeu, agendou, ganho) continuam valendo pra todos.
// - Os perfis já nascem com mensagens de rascunho, DESLIGADOS: só passam a
//   enviar depois que alguém revisar e ligar na tela de Follow-up.

export const PERFIL_TAGS = {
    estetica: { id: 'perfil-estetica', label: '✨ Estética', bg: 'rgba(251, 113, 133, 0.15)', color: '#fb7185', border: '#f43f5e' },
    dr_julimar: { id: 'perfil-dr-julimar', label: '🌿 Dr. Julimar', bg: 'rgba(132, 204, 22, 0.15)', color: '#a3e635', border: '#84cc16' },
};
export const PERFIL_TAG_IDS = Object.values(PERFIL_TAGS).map(t => t.id);

const H = 60, DIA = 1440;

export const FOLLOWUP_PERFIS_PADRAO = [
    {
        id: 'estetica',
        nome: 'Estética',
        ativo: false,
        tag: PERFIL_TAGS.estetica.id,
        pipeline_id: '',
        acao_final: 'tag:sem-resposta',
        steps: [
            { atraso_min: 3 * H, texto: 'Oi {{nome}}! Ficou alguma dúvida sobre o procedimento? Posso te ajudar por aqui 😊', template_name: '', so_horario_comercial: true },
            { atraso_min: 1 * DIA, texto: '{{nome}}, quer que eu veja um horário pra sua avaliação? Você prefere manhã ou tarde?', template_name: '', so_horario_comercial: true },
            { atraso_min: 3 * DIA, texto: '{{nome}}, passando pra lembrar que a avaliação é o primeiro passo: a especialista vê o seu caso e indica o melhor tratamento pra você. Quer que eu reserve um horário?', template_name: '', so_horario_comercial: true },
            { atraso_min: 7 * DIA, texto: 'Vou deixar seu atendimento em pausa por aqui, {{nome}}, mas quando quiser cuidar disso é só me chamar. Um abraço!', template_name: '', so_horario_comercial: true },
        ],
    },
    {
        id: 'dr_julimar',
        nome: 'Dr. Julimar',
        ativo: false,
        tag: PERFIL_TAGS.dr_julimar.id,
        pipeline_id: '',
        acao_final: 'tag:sem-resposta',
        steps: [
            { atraso_min: 1 * DIA, texto: 'Oi {{nome}}, tudo bem? Ficou alguma dúvida sobre a consulta com o Dr. Julimar? Pode me perguntar com calma 🌿', template_name: '', so_horario_comercial: true },
            { atraso_min: 3 * DIA, texto: '{{nome}}, na consulta o Dr. Julimar olha a sua saúde como um todo: intestino, nutrientes, energia. A partir disso ele monta um protocolo só pra você. Se quiser, te explico como funciona.', template_name: '', so_horario_comercial: true },
            { atraso_min: 7 * DIA, texto: '{{nome}}, quando sentir que é o momento de cuidar disso, me avisa que eu vejo a agenda do Dr. Julimar pra você.', template_name: '', so_horario_comercial: true },
            { atraso_min: 15 * DIA, texto: 'Oi {{nome}}! Passando só pra saber como você está. Se quiser retomar a conversa sobre a consulta, estou por aqui.', template_name: '', so_horario_comercial: true },
        ],
    },
];

export const ACOES_FINAIS = ['nada', 'mover:col-perdido', 'tag:sem-resposta'];

export function sanitizeFollowupStep(s) {
    s = s || {};
    return {
        atraso_min: Math.max(1, parseInt(s.atraso_min, 10) || 60),
        texto: String(s.texto || '').slice(0, 2000),
        template_name: String(s.template_name || '').trim().slice(0, 120),
        so_horario_comercial: !!s.so_horario_comercial,
    };
}

export function sanitizeFollowupPerfis(input) {
    if (!Array.isArray(input)) return FOLLOWUP_PERFIS_PADRAO.map(p => JSON.parse(JSON.stringify(p)));
    const out = [];
    const vistos = new Set();
    for (const raw of input.slice(0, 10)) {
        if (!raw || typeof raw !== 'object') continue;
        const id = String(raw.id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);
        if (!id || vistos.has(id)) continue;
        vistos.add(id);
        out.push({
            id,
            nome: String(raw.nome || '').trim().slice(0, 40) || id,
            ativo: !!raw.ativo,
            tag: String(raw.tag || '').trim().slice(0, 60),
            pipeline_id: String(raw.pipeline_id || '').trim().slice(0, 60),
            acao_final: ACOES_FINAIS.includes(raw.acao_final) ? raw.acao_final : 'nada',
            steps: (Array.isArray(raw.steps) ? raw.steps : []).slice(0, 10).map(sanitizeFollowupStep),
        });
    }
    return out;
}

function tagsDoLead(lead) {
    return String((lead && lead.tags) || '').split(',').map(s => s.trim()).filter(Boolean);
}

// Perfil que vale pra esse lead: primeiro pela etiqueta, depois pelo funil.
// Só perfis ligados e com pelo menos um lembrete contam.
export function perfilDoLead(lead, perfis) {
    const ativos = (perfis || []).filter(p => p && p.ativo && Array.isArray(p.steps) && p.steps.length);
    const tags = tagsDoLead(lead);
    const porTag = ativos.find(p => p.tag && tags.includes(p.tag));
    if (porTag) return porTag;
    const funil = (lead && lead.pipeline_id) || '';
    return ativos.find(p => p.pipeline_id && p.pipeline_id === funil) || null;
}

// O que fica gravado em crm_followup_runs.origem: 'global' ou 'perfil:<id>'.
export function origemDoPerfil(perfil) {
    return perfil ? `perfil:${perfil.id}` : 'global';
}

// Cadência de uma execução já aberta. ativo=false faz o run parar (perfil
// desligado ou apagado, ou cadência padrão desligada).
export function cadenciaDoRun(origem, cfg) {
    const o = String(origem || 'global');
    if (o.startsWith('perfil:')) {
        const p = (cfg.perfis || []).find(x => x.id === o.slice(7));
        if (!p) return { ativo: false, nome: 'perfil removido', steps: [], acao_final: 'nada' };
        return { ativo: !!p.ativo, nome: p.nome, steps: p.steps || [], acao_final: p.acao_final || 'nada' };
    }
    return { ativo: !!cfg.ativo, nome: 'Padrão', steps: Array.isArray(cfg.steps) ? cfg.steps : [], acao_final: cfg.acao_final || 'nada' };
}

// Cadência que o lead receberia se parasse de responder agora. null = nenhuma
// (padrão desligado e nenhum perfil serve).
export function cadenciaParaLead(lead, cfg) {
    const perfil = perfilDoLead(lead, cfg.perfis);
    if (perfil) return { origem: origemDoPerfil(perfil), ...cadenciaDoRun(origemDoPerfil(perfil), cfg) };
    if (cfg.ativo && Array.isArray(cfg.steps) && cfg.steps.length) return { origem: 'global', ...cadenciaDoRun('global', cfg) };
    return null;
}

// Menor atraso do 1º lembrete entre as cadências ligadas — define a janela de
// busca de leads quietos. null = nada ligado, não precisa nem procurar.
export function menorPrimeiroAtraso(cfg) {
    const atrasos = [];
    if (cfg.ativo && Array.isArray(cfg.steps) && cfg.steps.length) atrasos.push(cfg.steps[0].atraso_min || 60);
    for (const p of cfg.perfis || []) {
        if (p.ativo && p.steps && p.steps.length) atrasos.push(p.steps[0].atraso_min || 60);
    }
    return atrasos.length ? Math.min(...atrasos) : null;
}

// Classificação da IA: troca a etiqueta de perfil do lead (um lead tem um tipo só).
// Devolve a lista nova ou null se nada muda.
export function aplicarTagDePerfil(tagsAtuais, tipo) {
    const def = PERFIL_TAGS[tipo];
    if (!def) return null;
    const atuais = Array.isArray(tagsAtuais) ? tagsAtuais : tagsDoLead({ tags: tagsAtuais });
    const sem = atuais.filter(t => !PERFIL_TAG_IDS.includes(t));
    const nova = [...sem, def.id];
    const igual = nova.length === atuais.length && nova.every(t => atuais.includes(t));
    return igual ? null : nova;
}

export function leadJaClassificado(tags) {
    return tagsDoLead({ tags }).some(t => PERFIL_TAG_IDS.includes(t));
}

export const CLASSIFICAR_LEAD_TOOL_DECLARATION = {
    name: 'classificar_lead',
    description: 'Marca o tipo de interesse do paciente, para a equipe e para os lembretes automáticos. Use UMA vez, assim que ficar claro o que ele procura.',
    parameters: {
        type: 'OBJECT',
        properties: {
            tipo: {
                type: 'STRING',
                enum: Object.keys(PERFIL_TAGS),
                description: 'estetica = procedimentos estéticos (pele, rosto, corpo, harmonização, depilação, avaliação com a consultora). dr_julimar = consulta com o Dr. Julimar: saúde, nutrição ortomolecular, intestino, análise quântica, emagrecimento com acompanhamento médico.'
            }
        },
        required: ['tipo']
    }
};

export const CLASSIFICAR_LEAD_RULE = `

REGRA DE CLASSIFICAÇÃO DO LEAD:
Você tem a ferramenta classificar_lead. Assim que ficar claro se o paciente procura um procedimento estético (estetica) ou a consulta com o Dr. Julimar (dr_julimar), use a ferramenta uma vez, sem comentar isso com ele. Se ainda não está claro, não use. Isso não muda nada na sua resposta ao paciente.`;
