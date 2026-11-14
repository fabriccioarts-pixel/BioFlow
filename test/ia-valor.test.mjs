// node --test test/ia-valor.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { podeInformarValor, respostaPrecoParaIa, valorAntesDeAgendarRule, separarHandoff, formatarReais } from '../ia-valor.js';

const row = (valor, informar = false, nome = 'Limpeza de pele') => ({ nome, valor, condicao: '', informar });

test('faixas de valor: até R$ 1.000 informa; acima só se liberado; sem valor nunca', () => {
    assert.equal(podeInformarValor(row(180)), true);
    assert.equal(podeInformarValor(row(750)), true);
    assert.equal(podeInformarValor(row(1000)), true);
    assert.equal(podeInformarValor(row(1000.01)), false);
    assert.equal(podeInformarValor(row(3500)), false);
    assert.equal(podeInformarValor(row(3500, true)), true);
    assert.equal(podeInformarValor(row(null)), false);
    assert.equal(podeInformarValor(row(0)), true);
});

test('procedimento até o teto: a IA recebe o valor dele e não a consulta', () => {
    const r = respostaPrecoParaIa({ tipo: 'achou', row: row(180) });
    assert.equal(r.valor, 'R$ 180,00');
    assert.equal(r.consulta_avaliacao, undefined);
});

test('procedimento acima do teto: a IA NÃO recebe o valor dele, só a consulta de R$ 150', () => {
    const r = respostaPrecoParaIa({ tipo: 'achou', row: row(3500, false, 'Preenchimento de Glúteos') });
    assert.equal(r.valor, undefined);
    assert.equal(r.valor_autorizado, false);
    assert.equal(r.consulta_avaliacao.valor, 'R$ 150,00');
    assert.match(r.consulta_avaliacao.com, /Débora/);
    assert.match(r.consulta_avaliacao.abatimento, /mesmo dia/);
    assert.doesNotMatch(JSON.stringify(r), /3\.?500/);
});

test('sem valor na tabela ou fora da tabela: consulta de avaliação; ambíguo: pergunta qual', () => {
    assert.equal(respostaPrecoParaIa({ tipo: 'achou', row: row(null) }).consulta_avaliacao.valor, 'R$ 150,00');
    assert.equal(respostaPrecoParaIa({ tipo: 'nenhum' }).consulta_avaliacao.valor, 'R$ 150,00');
    const amb = respostaPrecoParaIa({ tipo: 'ambiguo', opcoes: ['Botox Testa', 'Botox Glabela'] });
    assert.equal(amb.ambiguo, true);
    assert.equal(amb.consulta_avaliacao, undefined);
});

test('regra do prompt: benefício antes do valor, só período, handoff com aviso', () => {
    const r = valorAntesDeAgendarRule({ temFerramentaPreco: true, temFerramentaFoto: true });
    assert.ok(r.indexOf('PRIMEIRO o benefício') < r.indexOf('LOGO EM SEGUIDA o valor'));
    assert.match(r, /R\$ 150,00/);
    assert.match(r, /consultar_preco/);
    assert.match(r, /buscar_imagem_resultado/);
    assert.match(r, /prefere de manhã ou à tarde/);
    assert.match(r, /Nunca sugira nem confirme dia ou horário/);
    const sem = valorAntesDeAgendarRule();
    assert.doesNotMatch(sem, /consultar_preco|buscar_imagem_resultado/);
});

test('handoff: token sozinho, com despedida, com grafia errada — o token nunca vai pro paciente', () => {
    assert.deepEqual(separarHandoff('QUALIFICADO_SILENCIO'), { handoff: true, texto: '' });
    assert.deepEqual(
        separarHandoff('Perfeito! Vou passar pra equipe confirmar o melhor horário à tarde pra você 😊\nQUALIFICADO_SILENCIO'),
        { handoff: true, texto: 'Perfeito! Vou passar pra equipe confirmar o melhor horário à tarde pra você 😊' }
    );
    assert.deepEqual(separarHandoff('Combinado!\n\nQUALIFICAÇÃO_SILENCIO.'), { handoff: true, texto: 'Combinado!' });
    assert.deepEqual(separarHandoff('Você prefere de manhã ou à tarde?'), { handoff: false, texto: 'Você prefere de manhã ou à tarde?' });
    assert.equal(separarHandoff('').handoff, false);
});

test('formata reais sem espaço inseparável', () => {
    assert.equal(formatarReais(150), 'R$ 150,00');
    assert.equal(formatarReais(0), 'gratuito');
});
