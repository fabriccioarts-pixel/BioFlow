// Página "Procedimentos": os procedimentos da clínica, o valor de cada um e quais deles a IA pode
// informar ("ativos") quando o paciente pergunta quanto custa. Os dados ficam em
// crm_settings.precos_ia (GET/PUT /api/precos). As mudanças só valem depois de "Salvar alterações".
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
    const plural = (n, um, varios) => (n === 1 ? um : varios);
    const ehAdmin = () => typeof loggedUser !== 'undefined' && !!loggedUser && (loggedUser.role === 'admin' || loggedUser.username === 'admin');
    const aviso = (msg, tipo = 'success') => { if (typeof showToast === 'function') showToast(msg, tipo, tipo === 'success' ? 3500 : 6000); };

    let linhas = [];            // { uid, nome, valor, condicao, informar }
    let originais = new Map();  // uid -> estado salvo (para contar alterações)
    let sel = new Set();        // uids selecionados
    let filtro = 'todos';       // todos | ativos | inativos | semvalor
    let uidSeq = 0;
    let carregado = false;
    let carregando = false;
    let salvando = false;
    let iniciado = false;
    let ultimoMarcado = null;   // uid do último checkbox clicado (Shift seleciona o intervalo)
    let erroCarga = '';

    const estadoDe = (l) => JSON.stringify([String(l.nome).trim(), l.valor, String(l.condicao).trim(), !!l.informar]);

    function definirLinhas(lista) {
        linhas = (lista || []).map((p) => ({
            uid: ++uidSeq,
            nome: String(p.nome || ''),
            valor: p.valor === null || p.valor === undefined ? null : Number(p.valor),
            condicao: String(p.condicao || ''),
            informar: !!p.informar && p.valor !== null && p.valor !== undefined
        }));
        originais = new Map(linhas.map((l) => [l.uid, estadoDe(l)]));
        sel = new Set();
        ultimoMarcado = null;
    }

    function visiveis() {
        const termo = norm(($('prc-busca') || {}).value);
        return linhas.filter((l) => {
            if (termo && !norm(l.nome).includes(termo)) return false;
            if (filtro === 'ativos') return l.informar;
            if (filtro === 'inativos') return !l.informar;
            if (filtro === 'semvalor') return l.valor === null;
            return true;
        });
    }

    function alteracoes() {
        let n = 0;
        const presentes = new Set();
        for (const l of linhas) {
            presentes.add(l.uid);
            if (!String(l.nome).trim() && !originais.has(l.uid)) continue; // linha nova em branco: ignora
            if (originais.get(l.uid) !== estadoDe(l)) n++;
        }
        for (const uid of originais.keys()) if (!presentes.has(uid)) n++; // removidos
        return n;
    }

    // ---------- desenho ----------
    function linhaHtml(l, admin) {
        const marcado = sel.has(l.uid);
        const temValor = l.valor !== null;
        const dis = admin ? '' : ' disabled';
        return `<tr data-uid="${l.uid}" class="${marcado ? 'is-sel' : ''}">
            <td class="prc-c-sel">${admin ? `<input type="checkbox" data-campo="sel" ${marcado ? 'checked' : ''} aria-label="Selecionar ${esc(l.nome || 'procedimento sem nome')}">` : ''}</td>
            <td><input class="prc-in" data-campo="nome" maxlength="120" value="${esc(l.nome)}" placeholder="Nome do procedimento" aria-label="Nome do procedimento"${dis}></td>
            <td><span class="prc-money"><span aria-hidden="true">R$</span><input class="prc-in prc-valor" data-campo="valor" type="number" min="0" max="1000000" step="0.01" inputmode="decimal" placeholder="—" value="${temValor ? l.valor : ''}" aria-label="Valor em reais"${dis}></span></td>
            <td><input class="prc-in" data-campo="condicao" maxlength="80" value="${esc(l.condicao)}" placeholder="ex.: por sessão" aria-label="Condição do valor"${dis}></td>
            <td class="prc-c-ativo"><label class="prc-switch" title="${temValor ? 'A IA pode informar este valor' : 'Defina um valor para poder ativar'}">
                <input type="checkbox" data-campo="informar" ${l.informar ? 'checked' : ''} ${temValor && admin ? '' : 'disabled'} aria-label="Ativo: a IA pode informar o valor"><span></span></label></td>
            <td class="prc-c-del">${admin ? `<button type="button" class="prc-del" data-acao="remover" title="Remover da lista" aria-label="Remover ${esc(l.nome || 'linha em branco')}"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>` : ''}</td>
        </tr>`;
    }

    function renderLinhas() {
        const corpo = $('prc-body');
        if (!corpo) return;
        const admin = ehAdmin();
        if (carregando && !linhas.length) {
            corpo.innerHTML = '<tr><td colspan="6" class="prc-vazio"><span class="amicro-loader"><span></span><span></span><span></span></span> Carregando procedimentos…</td></tr>';
        } else if (erroCarga) {
            corpo.innerHTML = `<tr><td colspan="6" class="prc-vazio">Não consegui carregar os procedimentos (${esc(erroCarga)}). <button type="button" class="prc-link" data-acao="recarregar">Tentar de novo</button></td></tr>`;
        } else if (!linhas.length) {
            corpo.innerHTML = `<tr><td colspan="6" class="prc-vazio">Nenhum procedimento ainda. ${admin ? 'Use <strong>Importar do Amigo</strong> ou <strong>Adicionar</strong>.' : ''}</td></tr>`;
        } else {
            const vis = visiveis();
            corpo.innerHTML = vis.length ? vis.map((l) => linhaHtml(l, admin)).join('')
                : '<tr><td colspan="6" class="prc-vazio">Nenhum procedimento encontrado com esse filtro.</td></tr>';
        }
    }

    function atualizarContagens() {
        const total = linhas.length;
        const ativos = linhas.filter((l) => l.informar).length;
        const semValor = linhas.filter((l) => l.valor === null).length;
        const set = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
        set('prc-count', total);
        set('prc-n-todos', total);
        set('prc-n-ativos', ativos);
        set('prc-n-inativos', total - ativos);
        set('prc-n-semvalor', semValor);
        set('prc-resumo', total ? `${total} ${plural(total, 'procedimento', 'procedimentos')} · ${total - semValor} com valor · ${ativos} ${plural(ativos, 'ativo', 'ativos')} para a IA` : '');
        document.querySelectorAll('#prc-chips .prc-chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filtro === filtro)));
    }

    function atualizarBarra() {
        const vis = visiveis();
        const visUids = vis.map((l) => l.uid);
        const marcadosVis = visUids.filter((u) => sel.has(u)).length;
        const master = $('prc-master');
        if (master) {
            master.checked = vis.length > 0 && marcadosVis === vis.length;
            master.indeterminate = marcadosVis > 0 && marcadosVis < vis.length;
            master.disabled = !vis.length;
        }
        const filtrando = filtro !== 'todos' || !!norm(($('prc-busca') || {}).value);
        const escopo = sel.size
            ? `${sel.size} ${plural(sel.size, 'selecionado', 'selecionados')}`
            : (filtrando ? `${vis.length} ${plural(vis.length, 'filtrado', 'filtrados')}` : `todos (${vis.length})`);
        const info = $('prc-sel-info');
        if (info) info.textContent = sel.size ? `${sel.size} ${plural(sel.size, 'selecionado', 'selecionados')}` : 'Nenhum selecionado';
        const limpar = $('prc-limpar-sel');
        if (limpar) limpar.hidden = !sel.size;
        const ativar = $('prc-ativar');
        const desativar = $('prc-desativar');
        if (ativar) { ativar.textContent = `Ativar ${escopo}`; ativar.disabled = !vis.length && !sel.size; }
        if (desativar) { desativar.textContent = `Desativar ${escopo}`; desativar.disabled = !vis.length && !sel.size; }
    }

    function atualizarSalvar() {
        const n = alteracoes();
        const salvar = $('prc-salvar');
        const descartar = $('prc-descartar');
        const info = $('prc-dirty');
        if (salvar) salvar.disabled = !n || salvando;
        if (descartar) descartar.hidden = !n;
        if (info) {
            info.hidden = !n;
            info.textContent = n ? `${n} ${plural(n, 'alteração não salva', 'alterações não salvas')}` : '';
        }
    }

    function render() {
        atualizarContagens();
        renderLinhas();
        atualizarBarra();
        atualizarSalvar();
    }

    function sincronizarSelecao() {
        document.querySelectorAll('#prc-body tr[data-uid]').forEach((tr) => {
            const marcado = sel.has(Number(tr.dataset.uid));
            tr.classList.toggle('is-sel', marcado);
            const cb = tr.querySelector('[data-campo="sel"]');
            if (cb) cb.checked = marcado;
        });
        atualizarBarra();
    }

    // ---------- ações ----------
    function editar(uid, campo, v) {
        const l = linhas.find((x) => x.uid === uid);
        if (!l) return;
        if (campo === 'valor') {
            const t = String(v).trim();
            const n = Number(t.replace(',', '.'));
            l.valor = t === '' || !Number.isFinite(n) || n < 0 ? null : n;
            const interruptor = document.querySelector(`#prc-body tr[data-uid="${uid}"] [data-campo="informar"]`);
            if (interruptor) {
                interruptor.disabled = l.valor === null;
                if (l.valor === null) { interruptor.checked = false; l.informar = false; }
                if (interruptor.parentElement) interruptor.parentElement.title = l.valor === null ? 'Defina um valor para poder ativar' : 'A IA pode informar este valor';
            }
        } else if (campo === 'informar') {
            l.informar = !!v && l.valor !== null;
        } else {
            l[campo] = String(v);
        }
        atualizarContagens();
        atualizarBarra();
        atualizarSalvar();
    }

    // Ativa/desativa os selecionados; sem seleção, vale para tudo o que está na lista filtrada.
    function aplicarAtivo(ligar) {
        const alvo = sel.size ? linhas.filter((l) => sel.has(l.uid)) : visiveis();
        if (!alvo.length) return;
        let mudou = 0;
        let semValor = 0;
        for (const l of alvo) {
            if (ligar) {
                if (l.valor === null) { semValor++; continue; }
                if (!l.informar) { l.informar = true; mudou++; }
            } else if (l.informar) { l.informar = false; mudou++; }
        }
        render();
        const partes = [ligar
            ? `${mudou} ${plural(mudou, 'procedimento ativado', 'procedimentos ativados')}`
            : `${mudou} ${plural(mudou, 'procedimento desativado', 'procedimentos desativados')}`];
        if (semValor) partes.push(`${semValor} sem valor ${plural(semValor, 'continuou inativo', 'continuaram inativos')}`);
        partes.push('Salve para valer.');
        aviso(partes.join(' · '), semValor ? 'warning' : 'success');
    }

    function marcarVisiveis(marcar) {
        for (const l of visiveis()) { if (marcar) sel.add(l.uid); else sel.delete(l.uid); }
        sincronizarSelecao();
    }

    function cliqueSelecao(ev, uid) {
        const marcar = ev.target.checked;
        if (ev.shiftKey && ultimoMarcado !== null) {
            const ids = visiveis().map((l) => l.uid);
            const a = ids.indexOf(ultimoMarcado);
            const b = ids.indexOf(uid);
            if (a >= 0 && b >= 0) {
                for (const u of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) { if (marcar) sel.add(u); else sel.delete(u); }
            }
        } else if (marcar) sel.add(uid); else sel.delete(uid);
        ultimoMarcado = uid;
        sincronizarSelecao();
    }

    function adicionar() {
        linhas.unshift({ uid: ++uidSeq, nome: '', valor: null, condicao: '', informar: false });
        filtro = 'todos';
        const busca = $('prc-busca');
        if (busca) busca.value = '';
        render();
        const primeiro = document.querySelector('#prc-body tr[data-uid] [data-campo="nome"]');
        if (primeiro) primeiro.focus();
    }

    function remover(uid) {
        linhas = linhas.filter((l) => l.uid !== uid);
        sel.delete(uid);
        render();
    }

    async function importarDoAmigo(btn) {
        if (btn) btn.disabled = true;
        try {
            const res = await fetch('/api/precos/amigo');
            const json = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(json.error || 'Erro ao consultar o Amigo');
            const existentes = new Set(linhas.map((l) => norm(l.nome)));
            let novos = 0;
            for (const nome of json.nomes || []) {
                const chave = norm(nome);
                if (existentes.has(chave)) continue;
                existentes.add(chave);
                linhas.push({ uid: ++uidSeq, nome, valor: null, condicao: '', informar: false });
                novos++;
            }
            linhas.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
            render();
            aviso(novos ? `${novos} ${plural(novos, 'procedimento novo importado', 'procedimentos novos importados')} do Amigo, sem valor. Preencha e salve.` : 'Nada novo: a lista já tem todos os procedimentos da agenda do Amigo.');
        } catch (e) {
            aviso('Não consegui importar do Amigo: ' + e.message, 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async function salvar() {
        if (salvando || !alteracoes()) return;
        salvando = true;
        let salvou = false;
        const botao = $('prc-salvar');
        if (botao) { botao.disabled = true; botao.textContent = 'Salvando…'; }
        try {
            const payload = linhas.filter((l) => String(l.nome).trim()).map((l) => ({ nome: l.nome, valor: l.valor, condicao: l.condicao, informar: l.informar }));
            const res = await fetch('/api/precos', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ precos: payload }) });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(json.error || 'Erro ao salvar');
            // Recarrega do que o servidor guardou (já limpo) e mantém a seleção pelo nome.
            const nomesSel = new Set(linhas.filter((l) => sel.has(l.uid)).map((l) => norm(l.nome)));
            definirLinhas(json.precos || []);
            for (const l of linhas) if (nomesSel.has(norm(l.nome))) sel.add(l.uid);
            salvou = true;
            aviso('Alterações salvas.');
        } catch (e) {
            aviso('Não consegui salvar: ' + e.message, 'error');
        } finally {
            salvando = false;
            if (botao) botao.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Salvar alterações';
            // Deu certo: redesenha com o que o servidor guardou. Falhou: mantém a tela como está
            // (foco, rolagem e o que foi digitado) e só reabilita os botões.
            if (salvou) render(); else atualizarSalvar();
        }
    }

    async function descartar() {
        if (!alteracoes()) return;
        const ok = typeof customConfirm === 'function'
            ? await customConfirm('Descartar todas as alterações que ainda não foram salvas?', 'Descartar alterações')
            : window.confirm('Descartar todas as alterações que ainda não foram salvas?');
        if (!ok) return;
        await carregar(true);
    }

    async function carregar(forcar) {
        if (carregando) return;
        if (carregado && !forcar) { render(); return; }
        carregando = true;
        erroCarga = '';
        render();
        try {
            const res = await fetch('/api/precos');
            const json = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(json.error || 'Erro ' + res.status);
            definirLinhas(json.precos || []);
            carregado = true;
        } catch (e) {
            erroCarga = e.message;
        } finally {
            carregando = false;
            render();
        }
    }

    // ---------- ligação com a página (uma vez só) ----------
    function iniciar() {
        if (iniciado) return;
        iniciado = true;
        const view = $('view-procedimentos');
        if (!view) return;

        const corpo = $('prc-body');
        corpo.addEventListener('input', (ev) => {
            const campo = ev.target.dataset && ev.target.dataset.campo;
            const tr = ev.target.closest && ev.target.closest('tr[data-uid]');
            if (!tr || !['nome', 'valor', 'condicao'].includes(campo)) return;
            editar(Number(tr.dataset.uid), campo, ev.target.value);
        });
        corpo.addEventListener('change', (ev) => {
            const tr = ev.target.closest && ev.target.closest('tr[data-uid]');
            if (tr && ev.target.dataset.campo === 'informar') editar(Number(tr.dataset.uid), 'informar', ev.target.checked);
        });
        corpo.addEventListener('click', (ev) => {
            const tr = ev.target.closest('tr[data-uid]');
            if (ev.target.matches && ev.target.matches('[data-campo="sel"]') && tr) return cliqueSelecao(ev, Number(tr.dataset.uid));
            const acao = ev.target.closest('[data-acao]');
            if (acao && acao.dataset.acao === 'remover' && tr) remover(Number(tr.dataset.uid));
            if (acao && acao.dataset.acao === 'recarregar') carregar(true);
        });

        let atraso = null;
        $('prc-busca').addEventListener('input', () => { clearTimeout(atraso); atraso = setTimeout(() => { renderLinhas(); atualizarBarra(); }, 120); });
        $('prc-chips').addEventListener('click', (ev) => {
            const b = ev.target.closest('.prc-chip');
            if (!b) return;
            filtro = b.dataset.filtro;
            atualizarContagens(); renderLinhas(); atualizarBarra();
        });
        $('prc-master').addEventListener('change', (ev) => marcarVisiveis(ev.target.checked));
        $('prc-limpar-sel').addEventListener('click', () => { sel = new Set(); sincronizarSelecao(); });
        $('prc-ativar').addEventListener('click', () => aplicarAtivo(true));
        $('prc-desativar').addEventListener('click', () => aplicarAtivo(false));
        $('prc-importar').addEventListener('click', (ev) => importarDoAmigo(ev.currentTarget));
        $('prc-adicionar').addEventListener('click', adicionar);
        $('prc-salvar').addEventListener('click', salvar);
        $('prc-descartar').addEventListener('click', descartar);

        // Não deixa recarregar/fechar a aba esquecendo alterações sem salvar.
        window.addEventListener('beforeunload', (ev) => {
            if (alteracoes()) { ev.preventDefault(); ev.returnValue = ''; }
        });
    }

    window.loadProcedimentos = function (forcar) {
        iniciar();
        view_somente_leitura();
        return carregar(!!forcar);
    };

    // Quem não é admin só consulta: a tela esconde as ações de edição.
    function view_somente_leitura() {
        const view = $('view-procedimentos');
        if (view) view.classList.toggle('is-readonly', !ehAdmin());
    }
})();
