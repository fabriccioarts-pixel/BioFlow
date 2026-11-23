// Lógica pura (sem banco, sem rede) usada pra:
// 1) reconhecer quando a EQUIPE confirma um agendamento numa mensagem do
//    WhatsApp ("Agendamento confirmado!", "Te agendei pro dia 21 às 9h",
//    "Prontinho, ficou agendado pro sábado"), pra o card ir pra Agendado
//    sozinho — antes o agendamento era combinado no chat e o card continuava em
//    Contatado, recebendo "você ainda tem interesse?";
// 2) ler a resposta da checagem de encerramento do follow-up, que agora
//    também sabe ADIAR (paciente disse "só confirmo na segunda").
// Testes: test/agendamento-confirmado.test.mjs (com mensagens reais da equipe).

function normalizar(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[_*~]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Frase que só PROPÕE agendar, não confirma.
const PROPOSTA = /\b(podemos|pode(?:mos)? ja|posso|quer|queria|gostaria|que tal|caso prefir|pre[ -]?agend|deseja|bora|vamos)\b/;

// Confirmação mesmo dentro de pergunta ("Te agendei pro dia 21 às 9h, tudo bem?").
const CONFIRMA_MESMO_COM_PERGUNTA = /\b(te agendei|agendei (voce|vc|a senhora|o senhor|seu|sua|ela|ele))\b/;

const CONFIRMA = [
    /\bagendamento (esta |foi |ta |tah |ficou |fica )?confirmad/,          // "Agendamento confirmado!", "Seu agendamento foi confirmado"
    /\b(esta|ta|tah|foi|ficou|fica|ja esta|ja ta) confirmad[oa]/,          // "retorno tá confirmado", "está confirmado"
    /\bconfirmadissim[oa]\b/,
    /\bagendad[oa] com sucesso\b/,
    /\b(ficou|fica|ja esta|ja ta|esta|ta) agendad[oa]\b/,                  // "Ficou agendado pro sábado"
    /\bprontinho\b.*\bagendad[oa]\b/,                                      // "Prontinho agendado para as 14:20"
    /(^|[,.!] ?|perfeito,? |certo,? |ok,? )agendad[oa] ?[!.]/,             // "agendado ! te aguardamos", "Perfeito, agendado!"
    /\bconsulta (esta |foi |ta )?confirmada\b/,
];

// true se o texto (mensagem da equipe) confirma um agendamento.
export function ehConfirmacaoDeAgendamento(texto) {
    const raw = String(texto || '');
    if (!raw.trim() || raw.startsWith('[FILE:') || raw.startsWith('📋 _Template')) return false;
    const n = normalizar(raw);
    if (CONFIRMA_MESMO_COM_PERGUNTA.test(n)) return true;
    // Frase por frase: pergunta ("Podemos deixar agendado?") e proposta não contam.
    const frases = raw.split(/(?<=[.!?\n])\s*/).map(f => f.trim()).filter(Boolean);
    return frases.some(f => {
        if (/\?\s*$/.test(f)) return false;
        const nf = normalizar(f);
        if (PROPOSTA.test(nf)) return false;
        return CONFIRMA.some(re => re.test(nf));
    });
}

// Lê a resposta da IA da checagem do follow-up:
//   "ENCERRADA: motivo" | "ADIAR: AAAA-MM-DD | motivo" | "ABERTA" (ou qualquer outra coisa).
// hojeISO = 'AAAA-MM-DD' (Brasília). Data inválida, no passado ou a mais de 30
// dias vira ABERTA (o follow-up segue normal): na dúvida, não trava a sequência.
export function interpretarChecagemFollowup(saida, hojeISO) {
    const s = String(saida || '').trim();
    const enc = s.match(/^ENCERRADA\s*:?\s*(.*)$/im);
    if (enc) return { tipo: 'encerrada', motivo: (enc[1].trim() || 'conversa concluída').slice(0, 120) };
    const adi = s.match(/^ADIAR\s*:?\s*(\d{4}-\d{2}-\d{2})\s*(?:\|\s*(.*))?$/im);
    if (adi) {
        const data = adi[1];
        const t = Date.parse(data + 'T12:00:00Z');
        const hoje = Date.parse(hojeISO + 'T12:00:00Z');
        if (Number.isFinite(t) && Number.isFinite(hoje) && t > hoje && t - hoje <= 30 * 86400000) {
            return { tipo: 'adiar', data, motivo: (String(adi[2] || '').trim() || 'paciente combinou de retornar').slice(0, 120) };
        }
    }
    return { tipo: 'aberta' };
}
