// PÁGINA "HOJE" — o dia em uma página. Lê /api/hoje (números ao vivo + resumo
// do dia gerado pelo Gemini a partir das 7:30) e monta a tela. O servidor é quem
// decide quando gerar; aqui só mostra, espera se estiver gerando e deixa pedir
// uma atualização manual.
(function () {
    let tentativasEspera = 0;
    let timerEspera = null;
    let ultimo = null;

    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const brl = v => (v == null || isNaN(v)) ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const num = v => (v == null || isNaN(v)) ? '—' : Number(v).toLocaleString('pt-BR');
    const $ = id => document.getElementById(id);

    function diaUTC(dia) { return new Date(`${dia}T12:00:00Z`); }

    function linhaRazao(rotulo, valor, destaque) {
        return `<div class="hoje-linha${destaque ? ' is-destaque' : ''}"><dt>${esc(rotulo)}</dt><dd>${valor}</dd></div>`;
    }

    function renderCabeca(d) {
        const data = diaUTC(d.dia);
        const semana = data.toLocaleDateString('pt-BR', { weekday: 'long', timeZone: 'UTC' });
        $('hoje-dia-semana').textContent = semana.charAt(0).toUpperCase() + semana.slice(1);
        $('hoje-data').textContent = data.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

        const r = d.resumo;
        let meta = '';
        if (r && r.gerado_em) {
            const hora = new Date(r.gerado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
            meta = `Resumo das ${hora}`;
        } else if (d.antes_do_horario) {
            meta = `O resumo sai às ${d.hora_resumo}`;
        } else if (d.gerando) {
            meta = 'Gerando o resumo…';
        }
        $('hoje-meta').textContent = meta;
        $('hoje-atualizar').hidden = !!d.antes_do_horario;
    }

    function renderResumo(d) {
        const r = d.resumo;
        const ia = r && r.ia;
        const box = $('hoje-resumo');
        const lista = $('hoje-prioridades');
        lista.innerHTML = '';

        if (d.antes_do_horario) {
            box.innerHTML = `<p class="hoje-vazio">O resumo do dia fica pronto às ${esc(d.hora_resumo)}. Os números ao lado já estão atualizados.</p>`;
            return;
        }
        if (d.gerando || !r) {
            box.innerHTML = '<p class="hoje-vazio">Preparando o resumo do dia…</p>';
            return;
        }
        if (!ia) {
            box.innerHTML = `<p class="hoje-vazio">Não consegui gerar o resumo com o Gemini agora${r.erro_ia ? ` (${esc(r.erro_ia)})` : ''}. Tente “Atualizar resumo” em alguns minutos.</p>`;
            return;
        }
        box.innerHTML = `<p>${esc(ia.resumo)}</p>`;
        (Array.isArray(ia.prioridades) ? ia.prioridades : []).slice(0, 4).forEach(p => {
            const li = document.createElement('li');
            li.textContent = p;
            lista.appendChild(li);
        });
    }

    function renderLeads(d) {
        const l = d.leads || {};
        const noite = d.resumo && d.resumo.dados && d.resumo.dados.leads_noite;
        let html = linhaRazao('Novos hoje', num(l.novos_hoje), true)
            + linhaRazao('Chegaram ontem', num(l.novos_ontem))
            + linhaRazao('No funil', num(l.total));
        if (noite && noite.por_origem) {
            Object.entries(noite.por_origem).sort((a, b) => b[1] - a[1]).slice(0, 3)
                .forEach(([origem, n]) => { html += linhaRazao(`Desde ontem 18h · ${origem}`, num(n)); });
        }
        $('hoje-leads').innerHTML = html;
    }

    function renderRelatorio(d) {
        const dados = d.resumo && d.resumo.dados;
        const alertas = $('hoje-alertas');
        alertas.innerHTML = '';
        if (!dados) {
            $('hoje-relatorio').innerHTML = `<p class="hoje-vazio">${d.antes_do_horario ? 'Sai junto com o resumo, às ' + esc(d.hora_resumo) + '.' : 'Aguardando o resumo do dia.'}</p>`;
            return;
        }
        let html = '';
        if (dados.agenda_hoje != null) html += linhaRazao('Atendimentos na agenda hoje', num(dados.agenda_hoje), true);
        if (dados.conversas_esperando != null) html += linhaRazao('Conversas esperando resposta', num(dados.conversas_esperando));
        if (dados.followups) html += linhaRazao('Follow-ups que saem hoje', num(dados.followups.hoje));
        if (dados.anuncios) {
            html += linhaRazao('Anúncios ontem · gasto', brl(dados.anuncios.gasto_ontem));
            html += linhaRazao('Anúncios ontem · custo por lead', brl(dados.anuncios.cpl_ontem));
            html += linhaRazao('Anúncios na semana · gasto', brl(dados.anuncios.gasto_semana));
        }
        if (dados.receita_mes != null) html += linhaRazao('Receita do mês', brl(dados.receita_mes));
        if (dados.conversao_semana_pct != null) html += linhaRazao('Viraram consulta na semana', `${num(dados.conversao_semana_pct)}%`);
        $('hoje-relatorio').innerHTML = html || '<p class="hoje-vazio">Sem números do relatório hoje.</p>';
        (dados.alertas || []).slice(0, 3).forEach(a => {
            const li = document.createElement('li');
            li.textContent = a;
            alertas.appendChild(li);
        });
    }

    function renderComemorativa(d) {
        const c = d.comemorativas || { hoje: null, proximas: [] };
        const ideia = d.resumo && d.resumo.ia && d.resumo.ia.comemorativa;
        let html = '';
        if (c.hoje) {
            html += `<p class="hoje-data-nome">${esc(c.hoje)}</p>`;
        } else {
            html += '<p class="hoje-vazio">Nenhuma data comemorativa hoje.</p>';
        }
        if (ideia) html += `<p class="hoje-texto">${esc(ideia)}</p>`;
        if (c.proximas && c.proximas.length) {
            html += '<dl class="hoje-razao hoje-razao--compacta">' + c.proximas.map(p => {
                const quando = diaUTC(p.dia).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
                return linhaRazao(p.nome, `${quando} · em ${p.em_dias} ${p.em_dias === 1 ? 'dia' : 'dias'}`);
            }).join('') + '</dl>';
        }
        $('hoje-comemorativa').innerHTML = html;
    }

    function renderConteudo(d) {
        const c = d.resumo && d.resumo.ia && d.resumo.ia.conteudo;
        if (!c || !c.ideia) {
            $('hoje-conteudo').innerHTML = `<p class="hoje-vazio">${d.antes_do_horario ? 'A sugestão de conteúdo sai junto com o resumo.' : 'Sem sugestão de conteúdo por enquanto.'}</p>`;
            return;
        }
        $('hoje-conteudo').innerHTML = `
            <p class="hoje-conteudo-tema"><span class="hoje-formato">${esc(c.formato || 'Post')}</span>${esc(c.tema || '')}</p>
            <p class="hoje-texto">${esc(c.ideia)}</p>
            ${c.legenda ? `<blockquote class="hoje-legenda" id="hoje-legenda">${esc(c.legenda)}</blockquote>
            <button type="button" class="hoje-btn-texto" onclick="copiarLegendaHoje(this)"><i class="fa-regular fa-copy"></i> Copiar legenda</button>` : ''}`;
    }

    function render(d) {
        ultimo = d;
        renderCabeca(d);
        renderResumo(d);
        renderLeads(d);
        renderRelatorio(d);
        renderComemorativa(d);
        renderConteudo(d);
    }

    async function carregarHoje() {
        clearTimeout(timerEspera);
        try {
            const res = await fetch('/api/hoje');
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Erro ao carregar o dia.');
            const d = await res.json();
            render(d);
            // Outro aparelho está gerando o resumo agora: confere de novo em alguns segundos.
            if (d.gerando && tentativasEspera < 8) {
                tentativasEspera++;
                timerEspera = setTimeout(carregarHoje, 8000);
            } else {
                tentativasEspera = 0;
            }
        } catch (e) {
            $('hoje-resumo').innerHTML = `<p class="hoje-vazio">${esc(e.message)}</p>`;
        }
    }

    async function atualizarResumoHoje() {
        const btn = $('hoje-atualizar');
        btn.disabled = true;
        $('hoje-meta').textContent = 'Gerando o resumo…';
        try {
            const res = await fetch('/api/hoje/gerar', { method: 'POST' });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) {
                if (typeof showToast === 'function') showToast(json.error || 'Não deu pra atualizar agora.', 'info');
            }
            await carregarHoje();
        } finally {
            btn.disabled = false;
        }
    }

    async function copiarLegendaHoje(btn) {
        const texto = ($('hoje-legenda') || {}).textContent || '';
        try {
            await navigator.clipboard.writeText(texto);
            const original = btn.innerHTML;
            btn.innerHTML = '<i class="fa-solid fa-check"></i> Copiada';
            setTimeout(() => { btn.innerHTML = original; }, 1600);
        } catch (e) {
            if (typeof showToast === 'function') showToast('Não consegui copiar. Selecione o texto e copie.', 'info');
        }
    }

    window.carregarHoje = carregarHoje;
    window.atualizarResumoHoje = atualizarResumoHoje;
    window.copiarLegendaHoje = copiarLegendaHoje;
})();
