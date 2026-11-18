// node --test test/followup-perfis.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    FOLLOWUP_PERFIS_PADRAO, PERFIL_TAGS, sanitizeFollowupPerfis, perfilDoLead, origemDoPerfil,
    cadenciaDoRun, cadenciaParaLead, menorPrimeiroAtraso, aplicarTagDePerfil, leadJaClassificado
} from '../followup-perfis.js';

const PADRAO_STEPS = [
    { atraso_min: 180, texto: 'Padrão 1', template_name: '', so_horario_comercial: true },
    { atraso_min: 1440, texto: 'Padrão 2', template_name: '', so_horario_comercial: true },
];
const cfgCom = (ligados = true, extra = {}) => ({
    ativo: true,
    steps: PADRAO_STEPS,
    acao_final: 'nada',
    perfis: sanitizeFollowupPerfis(FOLLOWUP_PERFIS_PADRAO).map(p => ({ ...p, ativo: ligados })),
    ...extra,
});

const leadEstetica = { id: '1', nome: 'Ana Souza', tags: 'vip,perfil-estetica', pipeline_id: null };
const leadJulimar = { id: '2', nome: 'Bruno Lima', tags: 'perfil-dr-julimar', pipeline_id: null };
const leadSemTipo = { id: '3', nome: 'Carla', tags: 'urgente', pipeline_id: null };

// Simulação do que o motor (followupTick) faz com cada lead: abre o run com a
// origem do perfil e depois manda os passos daquela cadência, um por um.
function simular(lead, cfg) {
    const cad = cadenciaParaLead(lead, cfg);
    if (!cad) return null;
    const run = { origem: cad.origem, step_idx: 0 };
    const enviados = [];
    for (;;) {
        const c = cadenciaDoRun(run.origem, cfg);
        if (!c.ativo || run.step_idx >= c.steps.length) return { origem: run.origem, enviados, acao_final: c.acao_final };
        const s = c.steps[run.step_idx];
        enviados.push({ apos: s.atraso_min, texto: s.texto.replace('{{nome}}', lead.nome.split(' ')[0]) });
        run.step_idx++;
    }
}

test('simulação: estética e Dr. Julimar recebem follow-ups diferentes; sem tipo recebe o padrão', () => {
    const cfg = cfgCom();
    const a = simular(leadEstetica, cfg);
    const b = simular(leadJulimar, cfg);
    const c = simular(leadSemTipo, cfg);

    assert.equal(a.origem, 'perfil:estetica');
    assert.equal(b.origem, 'perfil:dr_julimar');
    assert.equal(c.origem, 'global');

    assert.deepEqual(a.enviados.map(e => e.apos), [180, 1440, 4320, 10080]);      // 3h, 1, 3 e 7 dias
    assert.deepEqual(b.enviados.map(e => e.apos), [1440, 4320, 10080, 21600]);    // 1, 3, 7 e 15 dias
    assert.deepEqual(c.enviados.map(e => e.texto), ['Padrão 1', 'Padrão 2']);

    assert.match(a.enviados[0].texto, /^Oi Ana!.*procedimento/);
    assert.match(b.enviados[0].texto, /^Oi Bruno.*Dr\. Julimar/);
    assert.notDeepEqual(a.enviados.map(e => e.texto), b.enviados.map(e => e.texto));

    console.log('\n--- Estética (Ana) ---');
    a.enviados.forEach(e => console.log(`  após ${e.apos / 60}h: ${e.texto}`));
    console.log('--- Dr. Julimar (Bruno) ---');
    b.enviados.forEach(e => console.log(`  após ${e.apos / 60}h: ${e.texto}`));
});

test('perfis nascem desligados: nada muda até alguém ligar', () => {
    const cfg = cfgCom(false);
    FOLLOWUP_PERFIS_PADRAO.forEach(p => assert.equal(p.ativo, false));
    assert.equal(simular(leadEstetica, cfg).origem, 'global');
    assert.equal(simular(leadJulimar, cfg).origem, 'global');
    // padrão também desligado -> ninguém recebe nada (igual a antes)
    assert.equal(simular(leadEstetica, { ...cfg, ativo: false }), null);
    assert.equal(menorPrimeiroAtraso({ ...cfg, ativo: false }), null);
});

test('perfil ligado funciona mesmo com a cadência padrão desligada', () => {
    const cfg = cfgCom(true, { ativo: false });
    assert.equal(simular(leadJulimar, cfg).origem, 'perfil:dr_julimar');
    assert.equal(simular(leadSemTipo, cfg), null);
    assert.equal(menorPrimeiroAtraso(cfg), 180); // menor 1º atraso entre os perfis ligados
});

test('funil é regra extra: sem etiqueta, o funil escolhe o perfil; etiqueta tem prioridade', () => {
    const cfg = cfgCom();
    cfg.perfis.find(p => p.id === 'dr_julimar').pipeline_id = 'pl_julimar';
    assert.equal(perfilDoLead({ tags: '', pipeline_id: 'pl_julimar' }, cfg.perfis).id, 'dr_julimar');
    assert.equal(perfilDoLead({ tags: 'perfil-estetica', pipeline_id: 'pl_julimar' }, cfg.perfis).id, 'estetica');
    assert.equal(perfilDoLead({ tags: '', pipeline_id: 'outro' }, cfg.perfis), null);
});

test('run de perfil desligado ou apagado para; run antigo (global) segue a cadência padrão', () => {
    const cfg = cfgCom();
    assert.equal(cadenciaDoRun('perfil:estetica', cfg).ativo, true);
    cfg.perfis.find(p => p.id === 'estetica').ativo = false;
    assert.equal(cadenciaDoRun('perfil:estetica', cfg).ativo, false);
    assert.equal(cadenciaDoRun('perfil:sumiu', cfg).ativo, false);
    assert.deepEqual(cadenciaDoRun('global', cfg).steps, PADRAO_STEPS);
    assert.deepEqual(cadenciaDoRun(null, cfg).steps, PADRAO_STEPS);
    assert.equal(origemDoPerfil(null), 'global');
});

test('classificação da IA: troca a etiqueta de perfil sem mexer nas outras', () => {
    assert.deepEqual(aplicarTagDePerfil('vip,urgente', 'estetica'), ['vip', 'urgente', PERFIL_TAGS.estetica.id]);
    assert.deepEqual(aplicarTagDePerfil('vip,perfil-estetica', 'dr_julimar'), ['vip', PERFIL_TAGS.dr_julimar.id]);
    assert.equal(aplicarTagDePerfil('vip,perfil-estetica', 'estetica'), null); // já está
    assert.equal(aplicarTagDePerfil('vip', 'qualquer'), null);
    assert.equal(leadJaClassificado('vip,perfil-dr-julimar'), true);
    assert.equal(leadJaClassificado('vip'), false);
    assert.equal(leadJaClassificado(null), false);
});

test('config salva sem perfis ganha os rascunhos; lixo é descartado', () => {
    assert.equal(sanitizeFollowupPerfis(undefined).length, 2);
    const r = sanitizeFollowupPerfis([{ id: 'X Y!', nome: '', acao_final: 'apagar-tudo', steps: [{ atraso_min: -5 }] }, null, { id: 'x' }]);
    assert.equal(r.length, 2);
    assert.equal(r[0].id, 'xy');
    assert.equal(r[0].acao_final, 'nada');
    assert.equal(r[0].steps[0].atraso_min, 1); // mesma regra de antes: mínimo 1 min
    assert.equal(r[0].ativo, false);
});

// ---- Segmentação: período, unidade e interesse ---------------------------------
import {
    PERIODO_TAGS, aplicarTagExclusiva, periodoDoLead, unidadeCorrespondente, tagDaUnidade,
    atualizarNotaInteresse, foraDoPeriodo, CLASSIFICAR_LEAD_TOOL_DECLARATION
} from '../followup-perfis.js';

test('período vira etiqueta exclusiva e decide a janela dos lembretes', () => {
    const ehPeriodo = t => t.startsWith('periodo-');
    assert.deepEqual(aplicarTagExclusiva('vip', PERIODO_TAGS.manha.id, ehPeriodo), ['vip', 'periodo-manha']);
    assert.deepEqual(aplicarTagExclusiva('vip,periodo-manha', PERIODO_TAGS.tarde.id, ehPeriodo), ['vip', 'periodo-tarde']);
    assert.equal(aplicarTagExclusiva('periodo-tarde', PERIODO_TAGS.tarde.id, ehPeriodo), null);
    assert.equal(periodoDoLead('perfil-estetica,periodo-tarde'), 'tarde');
    assert.equal(periodoDoLead('vip'), null);
    // manhã 8h-12h, tarde 13h-18h
    assert.equal(foraDoPeriodo('manha', 9 * 60), false);
    assert.equal(foraDoPeriodo('manha', 14 * 60), true);
    assert.equal(foraDoPeriodo('tarde', 14 * 60), false);
    assert.equal(foraDoPeriodo('tarde', 10 * 60), true);
    assert.equal(foraDoPeriodo(null, 3 * 60), false); // sem período: só o horário comercial vale
});

test('unidade: só vira etiqueta se bater com uma unidade cadastrada', () => {
    const unidades = [{ id: 'unidade-taguatinga', nome: 'Natuclinic Taguatinga' }, { id: 'unidade-17', nome: 'Natuclinic Águas Claras' }];
    assert.equal(unidadeCorrespondente('taguatinga', unidades).id, 'unidade-taguatinga');
    assert.equal(unidadeCorrespondente('aguas claras', unidades).id, 'unidade-17');
    assert.equal(unidadeCorrespondente('Planaltina', unidades), null);
    assert.deepEqual(
        { id: tagDaUnidade(unidades[0]).id, label: tagDaUnidade(unidades[0]).label },
        { id: 'unidade-taguatinga', label: '📍 Taguatinga' });
});

test('interesse: uma linha só nas notas, atualizada aos poucos', () => {
    let n = atualizarNotaInteresse('Paciente veio do Instagram', { procedimento: 'limpeza de pele' });
    assert.equal(n, '🎯 Interesse: limpeza de pele\nPaciente veio do Instagram');
    n = atualizarNotaInteresse(n, { periodo: 'manha', unidade: 'Taguatinga' });
    assert.equal(n, '🎯 Interesse: limpeza de pele · Período: manhã · Unidade: Taguatinga\nPaciente veio do Instagram');
    assert.equal(atualizarNotaInteresse(n, { periodo: 'manha' }), null); // nada novo
    n = atualizarNotaInteresse(n, { periodo: 'tarde' });
    assert.match(n, /Período: tarde/);
    assert.equal((n.match(/🎯/g) || []).length, 1);
    assert.equal(atualizarNotaInteresse('', {}), null);
    console.log('\n--- Nota do lead ---\n' + n);
});

test('ferramenta da IA aceita período, unidade e procedimento (nenhum obrigatório)', () => {
    const p = CLASSIFICAR_LEAD_TOOL_DECLARATION.parameters;
    assert.deepEqual(Object.keys(p.properties).sort(), ['periodo', 'procedimento', 'tipo', 'unidade']);
    assert.deepEqual(p.properties.periodo.enum, ['manha', 'tarde']);
    assert.equal(p.required, undefined);
});
