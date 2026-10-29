// TEMA DA CLÍNICA — cores, fundo, fonte e cantos definidos pelo admin em
// "Personalização" e salvos em crm_settings ('ui_theme'), um visual para o modo
// escuro e outro para o claro. Carregado no <head> de todas as páginas: aplica o
// tema guardado no localStorage antes do primeiro paint (sem piscar o padrão) e
// depois confere com o servidor. O tema só sobrescreve variáveis de style.css —
// nenhum componente sabe que ele existe.
(function () {
    const CACHE_KEY = 'crm_ui_theme_cache';

    // Valores atuais do style.css: o painel começa daqui e o que for igual ao
    // padrão não gera override (as variáveis derivadas continuam como estão).
    const PADRAO = {
        dark: {
            fundo: { tipo: 'cor', cor: '#16171d', cor2: '#3b1d4a', angulo: 135, imagemV: 0, escurecer: 40, desfoque: 0, transparencia: 25 },
            destaque: '#e03720', menu: '#1b1c22', cartao: '#16171d', borda: '#2a2b32', texto: '#eaebf0', textoSec: '#abadba'
        },
        light: {
            fundo: { tipo: 'cor', cor: '#e8edf2', cor2: '#fbe3e0', angulo: 135, imagemV: 0, escurecer: 20, desfoque: 0, transparencia: 25 },
            destaque: '#e03720', menu: '#f8fafc', cartao: '#ffffff', borda: '#b5c4d9', texto: '#020817', textoSec: '#64748b'
        },
        fonte: 'padrao', tamanho: 100, cantos: 100
    };

    // Fontes do Google Fonts; 'padrao' é a Aspekta self-hosted do style.css.
    const FONTES = {
        padrao: { nome: 'Aspekta (padrão)', css: null },
        inter: { nome: 'Inter', css: 'Inter' },
        manrope: { nome: 'Manrope', css: 'Manrope' },
        jakarta: { nome: 'Plus Jakarta Sans', css: 'Plus Jakarta Sans' },
        dmsans: { nome: 'DM Sans', css: 'DM Sans' },
        poppins: { nome: 'Poppins', css: 'Poppins' },
        nunito: { nome: 'Nunito', css: 'Nunito' },
        outfit: { nome: 'Outfit', css: 'Outfit' },
        lora: { nome: 'Lora (serifada)', css: 'Lora' }
    };

    const clone = o => JSON.parse(JSON.stringify(o));

    // Junta o tema salvo com o padrão: chave faltando ou inválida volta ao padrão.
    function completo(t) {
        const out = clone(PADRAO);
        if (!t || typeof t !== 'object') return out;
        const cor = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
        const num = (v, min, max) => typeof v === 'number' && isFinite(v) ? Math.min(max, Math.max(min, v)) : null;
        for (const modo of ['dark', 'light']) {
            const src = t[modo] || {};
            for (const k of ['destaque', 'menu', 'cartao', 'borda', 'texto', 'textoSec']) if (cor(src[k])) out[modo][k] = src[k].toLowerCase();
            const f = src.fundo || {};
            if (['cor', 'degrade', 'imagem'].includes(f.tipo)) out[modo].fundo.tipo = f.tipo;
            if (cor(f.cor)) out[modo].fundo.cor = f.cor.toLowerCase();
            if (cor(f.cor2)) out[modo].fundo.cor2 = f.cor2.toLowerCase();
            for (const [k, min, max] of [['angulo', 0, 360], ['escurecer', 0, 90], ['desfoque', 0, 30], ['transparencia', 0, 90], ['imagemV', 0, 9e15]]) {
                const n = num(f[k], min, max);
                if (n !== null) out[modo].fundo[k] = n;
            }
        }
        if (FONTES[t.fonte]) out.fonte = t.fonte;
        const tam = num(t.tamanho, 85, 125); if (tam !== null) out.tamanho = tam;
        const can = num(t.cantos, 0, 250); if (can !== null) out.cantos = can;
        return out;
    }

    function hexRgb(hex) {
        const n = parseInt(hex.slice(1), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    // style.css guarda várias cores como "H S% L%" (formato shadcn) — converte.
    function hexHsl(hex) {
        let [r, g, b] = hexRgb(hex).map(x => x / 255);
        const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
        let h = 0, s = 0;
        if (max !== min) {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
            h *= 60;
        }
        return `${h.toFixed(1)} ${(s * 100).toFixed(1)}% ${(l * 100).toFixed(1)}%`;
    }
    const rgba = (hex, a) => `rgba(${hexRgb(hex).join(', ')}, ${a})`;

    function cssDoModo(sel, m, p, modo, imagemPreview) {
        const v = [];
        const f = m.fundo;
        const fundoMudou = f.tipo !== 'cor' || f.cor !== p.fundo.cor;
        if (fundoMudou) {
            // Com degradê/imagem as telas ficam translúcidas pra deixar o fundo aparecer.
            const base = f.tipo === 'cor' ? f.cor : rgba(f.cor, (100 - f.transparencia) / 100);
            v.push(`--bg-main: ${base}`, `--bg-dark: ${base}`, `--bg-agenda: ${base}`);
            if (f.tipo === 'cor') v.push(`--background: ${hexHsl(f.cor)}`);
        }
        if (m.destaque !== p.destaque) v.push(`--accent-primary: ${m.destaque}`, `--ring: ${hexHsl(m.destaque)}`);
        if (m.menu !== p.menu) v.push(`--header-bg: ${m.menu}`, `--sb-card-bg: ${m.menu}`);
        if (m.cartao !== p.cartao) v.push(`--card: ${hexHsl(m.cartao)}`, `--popover: ${hexHsl(m.cartao)}`);
        if (m.borda !== p.borda) v.push(`--border: ${hexHsl(m.borda)}`, `--input: ${hexHsl(m.borda)}`);
        if (m.texto !== p.texto) v.push(`--foreground: ${hexHsl(m.texto)}`, `--card-foreground: ${hexHsl(m.texto)}`, `--secondary-foreground: ${hexHsl(m.texto)}`);
        if (m.textoSec !== p.textoSec) v.push(`--muted-foreground: ${hexHsl(m.textoSec)}`);
        let css = v.length ? `${sel} { ${v.join('; ')}; }\n` : '';

        if (f.tipo !== 'cor') {
            const camada = f.tipo === 'degrade'
                ? `linear-gradient(${f.angulo}deg, ${f.cor}, ${f.cor2})`
                : `url("${imagemPreview || `/api/ui-theme/bg/${modo}?v=${f.imagemV}`}") center / cover no-repeat, ${f.cor}`;
            const borda = f.desfoque ? `-${f.desfoque * 2}px` : '0';
            const veu = modo === 'dark' ? '0, 0, 0' : '255, 255, 255';
            css += `${sel}::before { content: ''; position: fixed; inset: ${borda}; z-index: -2; pointer-events: none; background: ${camada}; ${f.desfoque ? `filter: blur(${f.desfoque}px);` : ''} }\n`;
            css += `${sel}::after { content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none; background: rgba(${veu}, ${f.escurecer / 100}); }\n`;
            css += `${sel} { background-color: ${f.cor}; }\n`;
        }
        return css;
    }

    // imagens: { dark?, light? } — URL local (blob:) de uma imagem escolhida no painel
    // e ainda não enviada, só pra pré-visualizar.
    function cssCompleto(t, imagens = {}) {
        let css = cssDoModo('body:not([data-theme="light"])', t.dark, PADRAO.dark, 'dark', imagens.dark)
            + cssDoModo('body[data-theme="light"]', t.light, PADRAO.light, 'light', imagens.light);
        const fonte = FONTES[t.fonte];
        if (fonte && fonte.css) css += `* { font-family: '${fonte.css}', system-ui, -apple-system, 'Segoe UI', sans-serif; }\n`;
        if (t.tamanho !== 100) css += `html { font-size: ${(13 * t.tamanho / 100).toFixed(2)}px; }\n`;
        return css;
    }

    function tagEstilo(id) {
        let el = document.getElementById(id);
        if (!el) {
            el = document.createElement('style');
            el.id = id;
            (document.head || document.documentElement).appendChild(el);
        }
        return el;
    }

    function carregarFonte(chave) {
        const fonte = FONTES[chave];
        let link = document.getElementById('crm-theme-font');
        if (!fonte || !fonte.css) { if (link) link.remove(); return; }
        const href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fonte.css).replace(/%20/g, '+')}:wght@400;500;600;700&display=swap`;
        if (link && link.href === href) return;
        if (!link) {
            link = document.createElement('link');
            link.id = 'crm-theme-font';
            link.rel = 'stylesheet';
            (document.head || document.documentElement).appendChild(link);
        }
        link.href = href;
    }

    // Cantos: style.css usa px fixos em ~270 regras, então a escala reescreve cada
    // border-radius das folhas de estilo da própria origem. Pílulas (999px) e % ficam
    // como estão. Estilo inline no HTML não é alcançado.
    let cantosAplicados = null;
    function aplicarCantos(fator) {
        const el = tagEstilo('crm-theme-cantos');
        if (fator === 100) { el.textContent = ''; cantosAplicados = 100; return; }
        if (cantosAplicados === fator) return;
        const escala = valor => {
            if (/%/.test(valor)) return null;
            const partes = valor.trim().split(/\s+/);
            let mudou = false;
            const novas = partes.map(p => {
                const m = /^([\d.]+)(px|rem|em)$/.exec(p);
                if (!m) return p;
                const n = parseFloat(m[1]);
                if ((m[2] === 'px' && n >= 100) || (m[2] !== 'px' && n >= 6) || n === 0) return p;
                mudou = true;
                return +(n * fator / 100).toFixed(2) + m[2];
            });
            return mudou ? novas.join(' ') : null;
        };
        const regras = [];
        const varrer = (lista, dentro) => {
            for (const r of lista) {
                if (r.cssRules && r.media) { varrer(r.cssRules, `@media ${r.media.mediaText}`); continue; }
                if (!r.style || !r.selectorText) continue;
                const br = r.style.getPropertyValue('border-radius');
                const novo = br && escala(br);
                if (!novo) continue;
                const regra = `${r.selectorText} { border-radius: ${novo}${r.style.getPropertyPriority('border-radius') ? ' !important' : ''}; }`;
                regras.push(dentro ? `${dentro} { ${regra} }` : regra);
            }
        };
        for (const sheet of Array.from(document.styleSheets)) {
            if (!sheet.href || new URL(sheet.href).origin !== location.origin) continue;
            try { varrer(sheet.cssRules, null); } catch (e) { /* folha ainda carregando */ }
        }
        el.textContent = regras.join('\n');
        cantosAplicados = fator;
    }

    let atual = null;
    function aplicar(tema, imagens) {
        atual = completo(tema);
        tagEstilo('crm-theme-css').textContent = cssCompleto(atual, imagens);
        carregarFonte(atual.fonte);
        if (document.readyState === 'complete') aplicarCantos(atual.cantos);
        else window.addEventListener('load', () => aplicarCantos(atual.cantos), { once: true });
        return atual;
    }

    function guardar(tema) {
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(tema || null)); } catch (e) { /* sem storage: só não fica em cache */ }
    }

    // Busca o tema do servidor (precisa de sessão). Sem login, fica o do cache.
    async function sincronizar() {
        try {
            const res = await fetch('/api/ui-theme');
            if (!res.ok) return;
            const json = await res.json();
            guardar(json.tema);
            aplicar(json.tema);
        } catch (e) { /* offline: segue com o cache */ }
    }

    let cache = null;
    try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) {}
    aplicar(cache);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sincronizar, { once: true });
    else sincronizar();

    window.CrmTheme = { PADRAO: clone(PADRAO), FONTES, completo, aplicar, guardar, sincronizar, atual: () => clone(atual) };
})();
