// PERSONALIZAÇÃO — painel lateral (só admin) que edita o tema da clínica com
// pré-visualização ao vivo. Quem aplica e saneia o tema é o theme.js
// (window.CrmTheme); aqui só se monta o rascunho e se salva em /api/ui-theme.
// Cancelar (ou fechar) volta ao tema salvo.
(function () {
    let rascunho = null;      // tema completo sendo editado
    let salvo = null;         // tema ao abrir o painel (pra cancelar)
    let modo = 'dark';        // aba aberta no painel
    let modoUsuario = null;   // claro/escuro que a pessoa usava antes de abrir
    let imagensPendentes = {}; // { dark|light: { dataUrl, blobUrl } } escolhidas e ainda não enviadas

    const CORES = [
        ['destaque', 'Cor de destaque', 'Botões, abas ativas, ícones e links'],
        ['menu', 'Menu lateral', 'Fundo da barra de navegação'],
        ['cartao', 'Cartões e painéis', 'Fundo de cartões, modais e listas'],
        ['borda', 'Bordas', 'Linhas e contornos'],
        ['texto', 'Texto', 'Títulos e texto principal'],
        ['textoSec', 'Texto secundário', 'Legendas, datas e dicas']
    ];

    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const clone = o => JSON.parse(JSON.stringify(o));

    function preview() {
        const imgs = {};
        for (const m of ['dark', 'light']) if (imagensPendentes[m]) imgs[m] = imagensPendentes[m].blobUrl;
        CrmTheme.aplicar(rascunho, imgs);
    }

    function el() { return document.getElementById('prs-drawer'); }

    window.openPersonalizacao = function () {
        if (!window.CrmTheme) return;
        if (typeof closeUserMenu === 'function') closeUserMenu();
        salvo = CrmTheme.atual();
        rascunho = clone(salvo);
        imagensPendentes = {};
        modoUsuario = document.body.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
        modo = modoUsuario;
        render();
        el().classList.add('is-open');
        document.addEventListener('keydown', escFecha);
    };

    function escFecha(e) { if (e.key === 'Escape') fecharPersonalizacao(false); }

    window.fecharPersonalizacao = function (manter) {
        if (!manter) CrmTheme.aplicar(salvo);
        for (const m of Object.keys(imagensPendentes)) URL.revokeObjectURL(imagensPendentes[m].blobUrl);
        imagensPendentes = {};
        if (modoUsuario === 'light') document.body.setAttribute('data-theme', 'light');
        else document.body.removeAttribute('data-theme');
        el().classList.remove('is-open');
        document.removeEventListener('keydown', escFecha);
    };

    window.prsModo = function (m) {
        modo = m;
        // Mostra ao vivo o modo que está sendo editado.
        if (m === 'light') document.body.setAttribute('data-theme', 'light');
        else document.body.removeAttribute('data-theme');
        render();
    };

    // Campos simples: data-k="dark.destaque", "light.fundo.angulo", "fonte"...
    window.prsSet = function (input) {
        const caminho = input.dataset.k.split('.');
        let alvo = rascunho;
        for (let i = 0; i < caminho.length - 1; i++) alvo = alvo[caminho[i]];
        const chave = caminho[caminho.length - 1];
        let valor = input.type === 'range' ? Number(input.value) : input.value;
        if (input.dataset.hex !== undefined) {
            valor = String(valor).trim().toLowerCase();
            if (!/^#?[0-9a-f]{6}$/.test(valor)) return; // espera terminar de digitar
            if (valor[0] !== '#') valor = '#' + valor;
        }
        alvo[chave] = valor;
        // Mantém o par cor/hex e o rótulo do slider em sincronia sem redesenhar tudo.
        document.querySelectorAll(`#prs-drawer [data-k="${input.dataset.k}"]`).forEach(o => { if (o !== input) o.value = valor; });
        const rot = document.querySelector(`#prs-drawer [data-rot="${input.dataset.k}"]`);
        if (rot) rot.textContent = rotulo(input.dataset.k, valor);
        preview();
    };

    window.prsTipoFundo = function (tipo) {
        rascunho[modo].fundo.tipo = tipo;
        render();
        preview();
    };

    window.prsEscolherImagem = async function (file) {
        if (!file) return;
        if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { showToast('Use uma imagem JPG, PNG ou WebP.', 'danger'); return; }
        try {
            const dataUrl = await comprimir(file);
            if (imagensPendentes[modo]) URL.revokeObjectURL(imagensPendentes[modo].blobUrl);
            const blob = await (await fetch(dataUrl)).blob();
            imagensPendentes[modo] = { dataUrl, blobUrl: URL.createObjectURL(blob) };
            rascunho[modo].fundo.tipo = 'imagem';
            render();
            preview();
        } catch (e) { showToast('Não consegui ler essa imagem.', 'danger'); }
    };

    // Até 1920px no lado maior, JPEG 82% — cabe numa linha do D1 com folga.
    function comprimir(file) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const escala = Math.min(1, 1920 / Math.max(img.width, img.height));
                const c = document.createElement('canvas');
                c.width = Math.round(img.width * escala);
                c.height = Math.round(img.height * escala);
                c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                URL.revokeObjectURL(img.src);
                resolve(c.toDataURL('image/jpeg', 0.82));
            };
            img.onerror = reject;
            img.src = URL.createObjectURL(file);
        });
    }

    window.prsRestaurarModo = function () {
        rascunho[modo] = clone(CrmTheme.PADRAO[modo]);
        if (imagensPendentes[modo]) { URL.revokeObjectURL(imagensPendentes[modo].blobUrl); delete imagensPendentes[modo]; }
        render();
        preview();
    };

    window.prsRestaurarGeral = function () {
        rascunho.fonte = CrmTheme.PADRAO.fonte;
        rascunho.tamanho = CrmTheme.PADRAO.tamanho;
        rascunho.cantos = CrmTheme.PADRAO.cantos;
        render();
        preview();
    };

    window.prsSalvar = async function () {
        const btn = document.getElementById('prs-salvar');
        for (const m of ['dark', 'light']) {
            const f = rascunho[m].fundo;
            if (f.tipo === 'imagem' && !f.imagemV && !imagensPendentes[m]) {
                showToast(`Escolha uma imagem de fundo para o modo ${m === 'dark' ? 'escuro' : 'claro'}.`, 'danger');
                return;
            }
        }
        btn.disabled = true;
        try {
            for (const m of Object.keys(imagensPendentes)) {
                const res = await fetch('/api/ui-theme/bg/' + m, {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ data: imagensPendentes[m].dataUrl })
                });
                const json = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(json.error || 'Erro ao enviar a imagem.');
                rascunho[m].fundo.imagemV = json.v;
            }
            const res = await fetch('/api/ui-theme', {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tema: rascunho })
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(json.error || 'Erro ao salvar.');
            CrmTheme.guardar(rascunho);
            salvo = CrmTheme.aplicar(rascunho);
            fecharPersonalizacao(true);
            showToast('Personalização salva para toda a clínica.');
        } catch (e) {
            showToast(e.message || 'Erro ao salvar a personalização.', 'danger');
        } finally {
            btn.disabled = false;
        }
    };

    function rotulo(k, v) {
        if (/angulo$/.test(k)) return v + '°';
        if (/desfoque$/.test(k)) return v + ' px';
        if (k === 'cantos') return v === 0 ? 'Retos' : v + '%';
        return v + '%';
    }

    function slider(k, titulo, min, max, passo, valor, ajuda) {
        return `<div class="prs-field">
            <div class="prs-field-top"><label for="prs-${k}">${titulo}</label><span data-rot="${k}">${rotulo(k, valor)}</span></div>
            <input type="range" id="prs-${k}" data-k="${k}" min="${min}" max="${max}" step="${passo}" value="${valor}" oninput="prsSet(this)">
            ${ajuda ? `<p class="prs-help">${ajuda}</p>` : ''}
        </div>`;
    }

    function campoCor(k, titulo, valor, ajuda) {
        return `<div class="prs-color">
            <input type="color" data-k="${k}" value="${valor}" oninput="prsSet(this)" aria-label="${esc(titulo)}">
            <div class="prs-color-txt"><span>${titulo}</span>${ajuda ? `<small>${ajuda}</small>` : ''}</div>
            <input type="text" class="prs-hex" data-k="${k}" data-hex value="${valor}" maxlength="7" spellcheck="false" oninput="prsSet(this)" aria-label="${esc(titulo)} em hexadecimal">
        </div>`;
    }

    function render() {
        const m = rascunho[modo];
        const f = m.fundo;
        const p = `${modo}.fundo`;
        const tipos = [['cor', 'Cor'], ['degrade', 'Degradê'], ['imagem', 'Imagem']];
        const temImagem = !!(imagensPendentes[modo] || f.imagemV);
        const thumb = imagensPendentes[modo] ? imagensPendentes[modo].blobUrl : (f.imagemV ? `/api/ui-theme/bg/${modo}?v=${f.imagemV}` : '');

        let fundo = `<div class="prs-seg" role="tablist" aria-label="Tipo de fundo">${tipos.map(([t, n]) =>
            `<button type="button" class="${f.tipo === t ? 'is-active' : ''}" onclick="prsTipoFundo('${t}')">${n}</button>`).join('')}</div>`;
        fundo += campoCor(`${p}.cor`, f.tipo === 'cor' ? 'Cor do fundo' : f.tipo === 'degrade' ? 'Cor inicial' : 'Cor por trás da imagem', f.cor);
        if (f.tipo === 'degrade') {
            fundo += campoCor(`${p}.cor2`, 'Cor final', f.cor2);
            fundo += slider(`${p}.angulo`, 'Direção', 0, 360, 5, f.angulo);
        }
        if (f.tipo === 'imagem') {
            fundo += `<div class="prs-img">
                ${thumb ? `<img src="${esc(thumb)}" alt="Imagem de fundo atual">` : '<div class="prs-img-vazia"><i class="fa-regular fa-image"></i></div>'}
                <label class="btn-secondary prs-img-btn"><i class="fa-solid fa-arrow-up-from-bracket"></i> ${temImagem ? 'Trocar imagem' : 'Escolher imagem'}
                    <input type="file" accept="image/jpeg,image/png,image/webp" hidden onchange="prsEscolherImagem(this.files[0]); this.value='';">
                </label>
            </div>`;
            fundo += slider(`${p}.escurecer`, modo === 'dark' ? 'Escurecer a imagem' : 'Clarear a imagem', 0, 90, 5, f.escurecer);
            fundo += slider(`${p}.desfoque`, 'Desfoque', 0, 30, 1, f.desfoque);
        }
        if (f.tipo !== 'cor') {
            fundo += slider(`${p}.transparencia`, 'Transparência das telas', 0, 90, 5, f.transparencia,
                'Quanto do fundo aparece por trás das telas. Cartões e menus continuam sólidos.');
        }

        const fontes = Object.entries(CrmTheme.FONTES).map(([k, v]) =>
            `<option value="${k}"${rascunho.fonte === k ? ' selected' : ''}>${esc(v.nome)}</option>`).join('');

        el().innerHTML = `
            <div class="prs-head">
                <div>
                    <h2><i class="fa-solid fa-palette"></i> Personalização</h2>
                    <p>Vale para toda a clínica. As mudanças aparecem ao vivo; só ficam ao salvar.</p>
                </div>
                <button class="prs-x" onclick="fecharPersonalizacao(false)" aria-label="Fechar sem salvar"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="prs-tabs" role="tablist">
                <button type="button" role="tab" class="${modo === 'dark' ? 'is-active' : ''}" aria-selected="${modo === 'dark'}" onclick="prsModo('dark')"><i class="fa-solid fa-moon"></i> Modo escuro</button>
                <button type="button" role="tab" class="${modo === 'light' ? 'is-active' : ''}" aria-selected="${modo === 'light'}" onclick="prsModo('light')"><i class="fa-solid fa-sun"></i> Modo claro</button>
            </div>
            <div class="prs-body">
                <section class="prs-sec">
                    <h3>Fundo</h3>
                    ${fundo}
                </section>
                <section class="prs-sec">
                    <h3>Cores</h3>
                    ${CORES.map(([k, t, a]) => campoCor(`${modo}.${k}`, t, m[k], a)).join('')}
                    <button type="button" class="prs-link" onclick="prsRestaurarModo()"><i class="fa-solid fa-rotate-left"></i> Restaurar o padrão do modo ${modo === 'dark' ? 'escuro' : 'claro'}</button>
                </section>
                <section class="prs-sec">
                    <h3>Texto e formas <small>valem para os dois modos</small></h3>
                    <div class="prs-field">
                        <div class="prs-field-top"><label for="prs-fonte">Fonte</label></div>
                        <select id="prs-fonte" class="prs-select" data-k="fonte" onchange="prsSet(this)">${fontes}</select>
                    </div>
                    ${slider('tamanho', 'Tamanho do texto', 85, 125, 5, rascunho.tamanho)}
                    ${slider('cantos', 'Arredondamento dos cantos', 0, 250, 10, rascunho.cantos)}
                    <button type="button" class="prs-link" onclick="prsRestaurarGeral()"><i class="fa-solid fa-rotate-left"></i> Restaurar fonte, tamanho e cantos</button>
                </section>
            </div>
            <div class="prs-foot">
                <button class="btn-cancel" onclick="fecharPersonalizacao(false)">Cancelar</button>
                <button class="btn-save" id="prs-salvar" onclick="prsSalvar()"><i class="fa-solid fa-floppy-disk"></i> Salvar</button>
            </div>`;
    }
})();
