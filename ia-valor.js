// Valor antes do agendamento — regras da IA do WhatsApp. Só lógica pura (sem
// banco, sem rede), testada em test/ia-valor.test.mjs.
//
// Decisão da clínica (14/11/2026):
// - Antes de convidar pra agendar, a IA informa o valor: primeiro o benefício
//   (ou uma foto de antes e depois), logo em seguida o valor.
// - Procedimento com valor na tabela até R$ 1.000: informa o valor dele.
// - Acima de R$ 1.000, ou sem valor na tabela: se for estético, informa a
//   consulta de avaliação com a consultora (R$ 150, abatidos do procedimento se
//   fechar no mesmo dia) e não cita o valor do procedimento.
// - O interruptor "ativo" da página Procedimentos virou a exceção: libera o
//   valor de um procedimento acima do teto.
// - Em vez de sugerir dias, a IA pergunta só o período (manhã ou tarde) e, com
//   a resposta, passa pra equipe confirmar dia e horário.

export const VALOR_TETO_INFORMAR = 1000;
export const CONSULTA_AVALIACAO = {
    valor: 150,
    profissional: 'consultora Débora',
    area: 'estética',
    abatimento: 'o valor da consulta é abatido do procedimento se a paciente fechar no mesmo dia'
};

export function formatarReais(v) {
    if (v === 0) return 'gratuito';
    return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/ /g, ' ');
}

const consultaParaIa = () => ({
    valor: formatarReais(CONSULTA_AVALIACAO.valor),
    com: CONSULTA_AVALIACAO.profissional,
    abatimento: CONSULTA_AVALIACAO.abatimento,
    vale_para: 'somente procedimentos estéticos'
});

// O valor deste procedimento pode ir pro paciente?
export function podeInformarValor(row) {
    if (!row || row.valor === null || row.valor === undefined) return false;
    return row.valor <= VALOR_TETO_INFORMAR || !!row.informar;
}

// O que a ferramenta consultar_preco devolve ao modelo. busca = resultado de
// buscarPrecoNaTabela: { tipo: 'achou', row } | { tipo: 'ambiguo', opcoes } | { tipo: 'nenhum' }.
// O valor do procedimento SÓ aparece quando pode ser informado: o que a IA não
// recebe, ela não tem como vazar.
export function respostaPrecoParaIa(busca) {
    if (busca && busca.tipo === 'achou') {
        const p = busca.row;
        if (podeInformarValor(p)) {
            return {
                encontrado: true,
                procedimento: p.nome,
                valor: formatarReais(p.valor),
                condicao: p.condicao || null,
                instrucao: `Informe exatamente este valor${p.condicao ? ' e esta condição' : ''}, sem arredondar nem inventar desconto, parcelamento ou promoção. Não fale da consulta de avaliação paga neste caso.`
            };
        }
        return {
            encontrado: true,
            procedimento: p.nome,
            valor_autorizado: false,
            consulta_avaliacao: consultaParaIa(),
            aviso: 'O valor deste procedimento NÃO é informado por WhatsApp: ele é definido na avaliação. NÃO cite nem estime o valor do procedimento. Se for um procedimento estético, informe o valor da consulta de avaliação (consulta_avaliacao) e que ele é abatido se fechar no mesmo dia.'
        };
    }
    if (busca && busca.tipo === 'ambiguo') {
        return {
            encontrado: false,
            ambiguo: true,
            opcoes: busca.opcoes,
            aviso: 'Há mais de um procedimento parecido. Pergunte ao paciente qual deles ele quer, sem citar valores ainda.'
        };
    }
    return {
        encontrado: false,
        consulta_avaliacao: consultaParaIa(),
        aviso: 'Esse procedimento não está na tabela de preços. NÃO invente nem estime o valor dele. Se for um procedimento estético, informe o valor da consulta de avaliação (consulta_avaliacao) e que ele é abatido se fechar no mesmo dia.'
    };
}

// Sempre anexada ao prompt (qualquer modo). temFerramentaPreco / temFerramentaFoto
// dizem quais ferramentas estão de fato disponíveis nesta chamada.
export function valorAntesDeAgendarRule({ temFerramentaPreco = false, temFerramentaFoto = false } = {}) {
    const consulta = `${formatarReais(CONSULTA_AVALIACAO.valor)} (consulta de avaliação com a ${CONSULTA_AVALIACAO.profissional}; ${CONSULTA_AVALIACAO.abatimento})`;
    return `

REGRA DE VALOR ANTES DE AGENDAR (vale mais que qualquer instrução acima, inclusive do contexto, que diga pra não falar de valor ou pra deixar o valor pra avaliação):
O paciente NÃO pode chegar no agendamento sem saber quanto vai pagar. Antes de convidar pra agendar (antes da pergunta "manhã ou à tarde?"), siga esta ordem:
1. PRIMEIRO o benefício: diga em uma ou duas frases o que o procedimento resolve na queixa que ele contou${temFerramentaFoto ? ', ou mande uma foto de antes e depois com a ferramenta buscar_imagem_resultado' : ''}. Isso vem antes do valor, nunca depois.
2. LOGO EM SEGUIDA o valor:${temFerramentaPreco ? `
   - Consulte a ferramenta consultar_preco com o nome do procedimento. Você pode (e deve) usá-la por conta própria nesse momento, mesmo que o paciente não tenha perguntado o preço.
   - Se ela devolver "valor": informe exatamente esse valor (e a condição, se houver).
   - Se ela devolver valor_autorizado: false ou encontrado: false com consulta_avaliacao: siga o item da consulta abaixo.` : ''}
   - Procedimento ESTÉTICO sem valor liberado: informe a consulta de avaliação — ${consulta}. Não cite nem estime o valor do procedimento; explique que o plano e o valor certos saem na avaliação.
   - Procedimento que NÃO é estético (nutrição, consulta médica, saúde da mulher, ozonioterapia, soroterapia etc.) sem valor liberado: não cite os ${formatarReais(CONSULTA_AVALIACAO.valor)}; diga que a equipe passa o valor certinho e siga pro agendamento.
3. SÓ DEPOIS convide pra agendar, perguntando o período (regra de agendamento abaixo).
- Benefício, valor e a pergunta do período podem ir na mesma resposta, nessa ordem. Se a foto for junto, a pergunta do período pode ficar pra resposta seguinte.
- Se o paciente perguntar o preço antes disso, responda na hora, na mesma ordem: uma frase de benefício e o valor.
- Informe o valor UMA vez. Se já informou nesta conversa, não repita, a não ser que ele pergunte de novo.
- Nunca invente valor, desconto, parcelamento ou promoção.

REGRA DE AGENDAMENTO — SÓ O PERÍODO (vale mais que qualquer instrução acima de sugerir dias):
- Você NÃO enxerga a agenda. Nunca sugira nem confirme dia ou horário ("amanhã", "segunda", "às 14h"), nem diga que tem vaga.
- Pra agendar, pergunte só: "Você prefere de manhã ou à tarde?"
- Quando o paciente responder o período (ou já disser um dia/horário que quer), faça o handoff: escreva UMA mensagem curta avisando que a equipe vai confirmar o dia e o horário com ele (repita o período ou o dia que ele disse, sem prometer que está livre) e, na ÚLTIMA linha, sozinha, a palavra QUALIFICADO_SILENCIO. Exemplo:
Perfeito! Vou passar pra equipe confirmar o melhor dia e horário à tarde pra você 😊
QUALIFICADO_SILENCIO
- Só faça esse handoff de agendamento se o valor já foi informado nesta conversa. Se ainda não foi, informe o valor primeiro (itens 1 e 2) e pergunte se pode seguir com o agendamento.`;
}

// Separa a resposta do modelo em mensagem pro paciente + sinal de handoff.
// Aceita o token sozinho (jeito antigo) ou na última linha, depois de uma
// mensagem de despedida. Tolera a grafia errada que o modelo às vezes produz
// ("QUALIFICAÇÃO_SILENCIO"). O token nunca sobra no texto que vai pro paciente.
export function separarHandoff(resposta) {
    const semAcento = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const ehToken = (linha) => /^[\s"'`*_.\-]*qualifica[a-z]*_silencio[\s"'`*_.!\-]*$/.test(semAcento(linha));
    const linhas = String(resposta || '').split('\n');
    const temToken = linhas.some(ehToken) || /^qualifica[a-z]*_silencio\b/.test(semAcento(resposta).trim());
    if (!temToken) return { handoff: false, texto: String(resposta || '').trim() };
    const texto = linhas.filter(l => !ehToken(l)).join('\n')
        .replace(/qualifica[a-zçã]*_sil[eê]ncio/gi, '')
        .replace(/\n{3,}/g, '\n\n').trim();
    return { handoff: true, texto };
}
