// node --test test/ia-anti-repeticao.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { extrairPergunta, ultimaPerguntaFeita, perguntaPendenteRule, WHATSAPP_AI_NAO_REPETIR_RULE } from '../ia-anti-repeticao.js';

const AGORA = Date.parse('2026-11-12T11:08:30Z');

// A conversa real que motivou a correção (08:06–08:07 em Brasília = 11:06–11:07 UTC).
const conversa = [
    { direction: 'in',  timestamp: '2026-11-12 11:06:10', message: 'Vou confirmar com ela, por conta dos horários na faculdade.' },
    { direction: 'in',  timestamp: '2026-11-12 11:06:20', message: 'Vcs passam cartão?' },
    { direction: 'in',  timestamp: '2026-11-12 11:06:40', message: 'E onde fica aqui em Planaltina?' },
    { direction: 'out', timestamp: '2026-11-12 11:07:05', message: 'Sim, aceitamos cartão de crédito, débito e Pix! Nossa clínica fica no Condomínio Estância 1, Módulo C/E, Lote 1, em frente à SkyFit. 😊' },
    { direction: 'out', timestamp: '2026-11-12 11:07:20', message: 'Sem problemas! Quando você falar com ela, costuma ficar melhor atendimento pela manhã ou à tarde?' },
    { direction: 'in',  timestamp: '2026-11-12 11:07:50', message: 'Pode me mandar a localização?' },
];

test('extrai só a frase da pergunta', () => {
    assert.equal(
        extrairPergunta('Sem problemas! Quando você falar com ela, costuma ficar melhor atendimento pela manhã ou à tarde?'),
        'Quando você falar com ela, costuma ficar melhor atendimento pela manhã ou à tarde?'
    );
    assert.equal(extrairPergunta('Ficamos em frente à SkyFit.'), '');
});

test('caso real: a pergunta "manhã ou tarde" aparece como já feita, com o pedido de localização depois', () => {
    const p = ultimaPerguntaFeita(conversa, AGORA);
    assert.match(p.pergunta, /manhã ou à tarde\?$/);
    assert.deepEqual(p.depois, ['Pode me mandar a localização?']);

    const regra = perguntaPendenteRule(conversa, AGORA);
    assert.match(regra, /Você já perguntou ao paciente: "Quando você falar com ela/);
    assert.match(regra, /"Pode me mandar a localização\?"/);
    assert.match(regra, /NÃO refaça essa pergunta/);
});

test('sem pergunta anterior da IA, não acrescenta nada ao prompt', () => {
    assert.equal(perguntaPendenteRule(conversa.slice(0, 4), AGORA), '');
    assert.equal(perguntaPendenteRule([], AGORA), '');
    assert.equal(perguntaPendenteRule(undefined, AGORA), '');
});

test('pergunta antiga (mais de 12h) pode ser retomada: não entra no prompt', () => {
    const amanha = AGORA + 13 * 3600 * 1000;
    assert.equal(perguntaPendenteRule(conversa, amanha), '');
});

test('foto enviada pela IA não conta como pergunta, e mídia do paciente não conta como fala', () => {
    const rows = [
        ...conversa.slice(0, 5),
        { direction: 'out', timestamp: '2026-11-12 11:07:25', message: '[FILE:antes-depois?.jpg]/api/whatsapp/media/123.jpg' },
        { direction: 'in',  timestamp: '2026-11-12 11:07:50', message: '[FILE:foto.jpg]/api/whatsapp/media/456.jpg' },
    ];
    const p = ultimaPerguntaFeita(rows, AGORA);
    assert.match(p.pergunta, /manhã ou à tarde\?$/);
    assert.deepEqual(p.depois, []);
    assert.equal(perguntaPendenteRule(rows, AGORA), '');
});

test('regra fixa cobre pergunta pendente e pedido de localização', () => {
    assert.match(WHATSAPP_AI_NAO_REPETIR_RULE, /NÃO refaça a pergunta/);
    assert.match(WHATSAPP_AI_NAO_REPETIR_RULE, /mande SÓ o link/);
});
