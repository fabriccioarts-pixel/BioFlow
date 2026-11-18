// Balão de template do WhatsApp no chat do CRM. Só lógica pura (sem DOM, sem
// rede) — testada em test/wa-template-bubble.test.mjs.
//
// O servidor grava o template enviado no histórico como texto
// (renderTemplateForHistory em api-server.js):
//   "📋 _Template: follow_up_2_\n<cabeçalho>\n\n<corpo>\n\n<rodapé>"
// ou, quando não deu pra montar o texto, "📋 Template enviado: *nome*".
// Os botões não ficam gravados. Aqui a gente separa cabeçalho/corpo/rodapé
// usando a definição do template na Meta (GET /api/whatsapp/templates) e
// pega os botões dela — então funciona igual pras mensagens antigas e novas.
//
// Carrega como <script> no navegador (window.WaTemplateBubble) e como módulo
// no Node (globalThis.WaTemplateBubble) pros testes.
(function (root) {
    const TEMPLATE_RE = /^📋 _Template: (.*)_\n([\s\S]*)$/;
    const TEMPLATE_SEM_TEXTO_RE = /^📋 Template enviado: \*(.+)\*\s*$/;

    // Texto gravado no histórico → { name, corpo } (ou null se não é template).
    function parseTemplateMessage(text) {
        if (typeof text !== 'string' || !text.startsWith('📋')) return null;
        let m = text.match(TEMPLATE_RE);
        if (m) return { name: m[1].trim(), corpo: m[2].trim() };
        m = text.match(TEMPLATE_SEM_TEXTO_RE);
        if (m) return { name: m[1].trim(), corpo: '' };
        return null;
    }

    // Uma linha da listagem da Meta → definição enxuta que o balão usa.
    function toTemplateDef(row) {
        const comps = (row && row.components) || [];
        const find = (type) => comps.find(c => String(c.type || '').toUpperCase() === type);
        const header = find('HEADER');
        const body = find('BODY');
        const footer = find('FOOTER');
        const buttonsComp = find('BUTTONS');
        const headerFormat = header ? String(header.format || 'TEXT').toUpperCase() : null;
        return {
            name: row.name,
            headerFormat,
            headerText: header && headerFormat === 'TEXT' ? (header.text || '') : '',
            bodyText: (body && body.text) || '',
            footerText: (footer && footer.text) || '',
            buttons: ((buttonsComp && buttonsComp.buttons) || []).map(b => ({
                type: String(b.type || 'QUICK_REPLY').toUpperCase(),
                text: b.text || '',
                url: b.url || '',
                phone_number: b.phone_number || '',
            })),
        };
    }

    // Listagem da Meta → Map nome → definição. O mesmo nome pode existir em
    // vários idiomas: fica o aprovado em pt, igual getWhatsappTemplateMeta.
    function indexTemplateDefs(rows) {
        const byName = new Map();
        const score = (r) => (r.status === 'APPROVED' ? 2 : 0) + (/^pt/i.test(r.language || '') ? 1 : 0);
        (Array.isArray(rows) ? rows : []).forEach(r => {
            if (!r || !r.name) return;
            const atual = byName.get(r.name);
            if (!atual || score(r) > score(atual)) byName.set(r.name, r);
        });
        const out = new Map();
        byName.forEach((r, name) => out.set(name, toTemplateDef(r)));
        return out;
    }

    function escapeRegex(s) {
        return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // Texto do template com {{variáveis}} → regex que casa com ele preenchido.
    function templateTextRegex(txt) {
        const pedacos = String(txt).split(/\{\{\s*[\w\d_]+\s*\}\}/g).map(escapeRegex);
        return pedacos.join('[\\s\\S]+?');
    }

    // Separa o texto gravado nas partes do balão. Sem a definição (template
    // apagado na Meta, ou listagem ainda carregando), tudo vira corpo.
    function splitTemplateParts(parsed, def) {
        const parts = { name: parsed.name, headerMedia: null, header: '', body: parsed.corpo || '', footer: '', buttons: [] };
        if (!def) return parts;
        let resto = parts.body;

        // "Template enviado: *nome*": o texto não foi gravado, então mostra o da
        // definição — sem os valores das variáveis, que se perderam.
        if (!resto && def.bodyText) resto = def.bodyText.replace(/\{\{\s*[\w\d_]+\s*\}\}/g, '…');

        if (def.headerFormat && def.headerFormat !== 'TEXT') {
            parts.headerMedia = def.headerFormat.toLowerCase();
            const marca = `[${parts.headerMedia}]`;
            if (resto.startsWith(marca)) resto = resto.slice(marca.length).replace(/^\s+/, '');
        } else if (def.headerText) {
            const m = resto.match(new RegExp('^(' + templateTextRegex(def.headerText) + ')\\n\\n'));
            if (m) {
                parts.header = m[1];
                resto = resto.slice(m[0].length);
            }
        }

        if (def.footerText) {
            const sufixo = '\n\n' + def.footerText;
            if (resto.endsWith(sufixo)) resto = resto.slice(0, -sufixo.length);
            else if (resto === def.footerText) resto = '';
            parts.footer = def.footerText;
        }

        parts.body = resto.trim();
        parts.buttons = def.buttons || [];
        return parts;
    }

    const MEDIA_LABEL = { image: ['fa-regular fa-image', 'Imagem'], video: ['fa-solid fa-video', 'Vídeo'], document: ['fa-regular fa-file-lines', 'Documento'], location: ['fa-solid fa-location-dot', 'Localização'] };
    const BUTTON_ICON = { URL: 'fa-solid fa-arrow-up-right-from-square', PHONE_NUMBER: 'fa-solid fa-phone', COPY_CODE: 'fa-regular fa-copy', QUICK_REPLY: 'fa-solid fa-reply' };

    // Partes → HTML do conteúdo do balão. format = formatador de texto do
    // WhatsApp (*negrito*, _itálico_, quebras de linha) que já escapa HTML;
    // esc = escapeHtml.
    function renderTemplateBubbleHTML(parts, format, esc) {
        let html = `<div class="wa-tpl" data-wa-tpl="${esc(parts.name)}">`;
        if (parts.headerMedia) {
            const [icon, label] = MEDIA_LABEL[parts.headerMedia] || ['fa-regular fa-file', parts.headerMedia];
            html += `<div class="wa-tpl-media"><i class="${icon}" aria-hidden="true"></i><span>${esc(label)}</span></div>`;
        }
        if (parts.header) html += `<div class="wa-tpl-header">${format(parts.header)}</div>`;
        if (parts.body) html += `<div class="wa-tpl-body">${format(parts.body)}</div>`;
        if (parts.footer) html += `<div class="wa-tpl-footer">${esc(parts.footer)}</div>`;
        if (parts.buttons && parts.buttons.length) {
            html += '<div class="wa-tpl-buttons">';
            parts.buttons.forEach(b => {
                const icon = BUTTON_ICON[b.type] || 'fa-solid fa-list-ul';
                const inner = `<i class="${icon}" aria-hidden="true"></i><span>${esc(b.text)}</span>`;
                // URL com variável ({{1}}) não dá pra abrir — o valor não fica gravado.
                if (b.type === 'URL' && b.url && !/\{\{/.test(b.url) && /^https?:\/\//i.test(b.url)) {
                    html += `<a class="wa-tpl-btn" href="${esc(b.url)}" target="_blank" rel="noopener noreferrer" title="${esc(b.url)}">${inner}</a>`;
                } else {
                    const title = b.type === 'PHONE_NUMBER' && b.phone_number ? ` title="${esc(b.phone_number)}"` : '';
                    html += `<div class="wa-tpl-btn"${title}>${inner}</div>`;
                }
            });
            html += '</div>';
        }
        return html + '</div>';
    }

    // Texto curto pra lista de conversas / mensagem citada: o corpo, sem a
    // linha "📋 _Template: nome_".
    function templatePreviewText(parsed) {
        const corpo = (parsed.corpo || '').replace(/^\[(image|video|document|location)\]\s*/i, '');
        return '📋 ' + (corpo ? corpo.replace(/\s+/g, ' ').trim() : parsed.name);
    }

    root.WaTemplateBubble = { parseTemplateMessage, toTemplateDef, indexTemplateDefs, splitTemplateParts, renderTemplateBubbleHTML, templatePreviewText };
})(typeof window !== 'undefined' ? window : globalThis);
