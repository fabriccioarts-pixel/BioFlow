// node --test test/wa-template-bubble.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import '../wa-template-bubble.js';

const { parseTemplateMessage, indexTemplateDefs, splitTemplateParts, renderTemplateBubbleHTML, templatePreviewText } = globalThis.WaTemplateBubble;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (s) => esc(s).replace(/\*([^*]+)\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');

const FOLLOW_UP_3 = {
    name: 'follow_up_3', status: 'APPROVED', language: 'pt_BR',
    components: [
        { type: 'BODY', text: 'Oi, {{nome}}. Como não tivemos retorno, gostaríamos de confirmar se ainda há interesse.\n\nCaso queira continuar, basta selecionar a opção abaixo.' },
        { type: 'FOOTER', text: 'Natuclinic' },
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Quero continuar' }, { type: 'QUICK_REPLY', text: 'Não tenho interesse' }] },
    ],
};
const PROMO = {
    name: 'promo', status: 'APPROVED', language: 'pt_BR',
    components: [
        { type: 'HEADER', format: 'TEXT', text: 'Novidade, {{1}}!' },
        { type: 'BODY', text: 'Temos *horários* livres.' },
        { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Ver site', url: 'https://natuclinic.com.br' }, { type: 'PHONE_NUMBER', text: 'Ligar', phone_number: '+5561999999999' }] },
    ],
};
const defs = indexTemplateDefs([FOLLOW_UP_3, PROMO, { ...PROMO, language: 'en_US', status: 'REJECTED', components: [] }]);

test('reconhece os dois formatos gravados no histórico (nome com sublinhado)', () => {
    assert.deepEqual(parseTemplateMessage('📋 _Template: follow_up_2_\nOi Liliane'), { name: 'follow_up_2', corpo: 'Oi Liliane' });
    assert.deepEqual(parseTemplateMessage('📋 Template enviado: *follow_up_2*'), { name: 'follow_up_2', corpo: '' });
    assert.equal(parseTemplateMessage('Oi, tudo bem?'), null);
    assert.equal(parseTemplateMessage(null), null);
});

test('mensagem antiga: separa corpo e rodapé e pega os botões da definição', () => {
    const texto = '📋 _Template: follow_up_3_\nOi, Liliane. Como não tivemos retorno, gostaríamos de confirmar se ainda há interesse.\n\nCaso queira continuar, basta selecionar a opção abaixo.\n\nNatuclinic';
    const parts = splitTemplateParts(parseTemplateMessage(texto), defs.get('follow_up_3'));
    assert.equal(parts.body, 'Oi, Liliane. Como não tivemos retorno, gostaríamos de confirmar se ainda há interesse.\n\nCaso queira continuar, basta selecionar a opção abaixo.');
    assert.equal(parts.footer, 'Natuclinic');
    assert.deepEqual(parts.buttons.map(b => b.text), ['Quero continuar', 'Não tenho interesse']);
});

test('cabeçalho de texto com variável vira cabeçalho; prefere a versão aprovada em pt', () => {
    const parts = splitTemplateParts(parseTemplateMessage('📋 _Template: promo_\nNovidade, Ana!\n\nTemos *horários* livres.'), defs.get('promo'));
    assert.equal(parts.header, 'Novidade, Ana!');
    assert.equal(parts.body, 'Temos *horários* livres.');
    assert.equal(parts.buttons.length, 2);
});

test('sem definição (template apagado na Meta): tudo vira corpo, sem botões', () => {
    const parts = splitTemplateParts(parseTemplateMessage('📋 _Template: sumiu_\nOlá'), undefined);
    assert.equal(parts.body, 'Olá');
    assert.deepEqual(parts.buttons, []);
});

test('"Template enviado: *nome*" mostra o corpo da definição', () => {
    const parts = splitTemplateParts(parseTemplateMessage('📋 Template enviado: *promo*'), defs.get('promo'));
    assert.match(parts.body, /horários/);
    const f3 = splitTemplateParts(parseTemplateMessage('📋 Template enviado: *follow_up_3*'), defs.get('follow_up_3'));
    assert.match(f3.body, /^Oi, …\. Como/);
    assert.equal(f3.footer, 'Natuclinic');
});

test('HTML: sem a linha crua, com botões, link só pra URL fixa e texto escapado', () => {
    const parts = splitTemplateParts(parseTemplateMessage('📋 _Template: promo_\nNovidade, <b>Ana</b>!\n\nTemos *horários* livres.'), defs.get('promo'));
    const html = renderTemplateBubbleHTML(parts, fmt, esc);
    assert.doesNotMatch(html, /_Template:/);
    assert.match(html, /class="wa-tpl-header">Novidade, &lt;b&gt;Ana&lt;\/b&gt;!/);
    assert.match(html, /<strong>horários<\/strong>/);
    assert.match(html, /<a class="wa-tpl-btn" href="https:\/\/natuclinic.com.br"/);
    assert.match(html, /<div class="wa-tpl-btn" title="\+5561999999999">/);
    const urlVar = renderTemplateBubbleHTML({ name: 'x', body: 'a', buttons: [{ type: 'URL', text: 'Abrir', url: 'https://x.com/{{1}}' }] }, fmt, esc);
    assert.doesNotMatch(urlVar, /<a /);
    const js = renderTemplateBubbleHTML({ name: 'x', body: 'a', buttons: [{ type: 'URL', text: 'Abrir', url: 'javascript:alert(1)' }] }, fmt, esc);
    assert.doesNotMatch(js, /href/);
});

test('prévia da lista de conversas mostra o corpo, não o nome cru', () => {
    assert.equal(templatePreviewText(parseTemplateMessage('📋 _Template: follow_up_2_\nOi Liliane,\nPassando')), '📋 Oi Liliane, Passando');
    assert.equal(templatePreviewText(parseTemplateMessage('📋 Template enviado: *promo*')), '📋 promo');
});
