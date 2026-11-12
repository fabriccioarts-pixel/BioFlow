// Anti-repetição da IA do WhatsApp. Só lógica pura (sem banco, sem rede), pra
// poder ser testada sozinha: test/ia-anti-repeticao.test.mjs.
//
// Caso real que motivou: a IA perguntou "manhã ou à tarde?", a paciente não
// respondeu e só pediu a localização; um minuto depois a IA refez a mesma
// pergunta com outras palavras e reescreveu o endereço que tinha acabado de
// mandar. Duas causas no prompt: (1) o contexto manda "sempre termine com uma
// pergunta" e o modo vendas manda fechar com "manhã ou tarde?", sem nenhuma
// exceção pra pergunta que já está na tela sem resposta; (2) nada dizia pra
// não repetir informação de uma resposta pra outra (a regra de formato só
// proibia repetir dentro da MESMA resposta).

// Sempre anexada, em qualquer modo.
export const WHATSAPP_AI_NAO_REPETIR_RULE = `

NÃO SE REPITA ENTRE UMA RESPOSTA E OUTRA (vale mais que qualquer instrução acima de terminar com pergunta ou de propor o próximo passo):
- Antes de responder, releia as SUAS últimas mensagens na conversa. O paciente já leu o que está lá.
- Pergunta sua que ficou sem resposta: se o paciente não respondeu e só pediu ou perguntou outra coisa, responda SÓ o que ele pediu agora e NÃO refaça a pergunta, nem com outras palavras. Ela continua na tela dele. Nesse caso a resposta termina SEM pergunta nenhuma.
- Informação que você acabou de dar (endereço, horário, formas de pagamento, explicação de procedimento): não escreva de novo. Só repita se o paciente pedir explicitamente de novo ou mostrar que não entendeu.
- Pedido de localização ("manda a localização", "me manda o mapa", "como chego"): se o contexto tiver o link do mapa da unidade, mande o link, numa mensagem curta. Se você já escreveu o endereço nas suas últimas mensagens, mande SÓ o link, sem reescrever o endereço. Se não houver link no contexto, passe o endereço uma única vez; nunca invente link.
- "Vou ver", "vou confirmar com fulano", "depois te falo": acolha em uma frase e espere. Não insista na mesma pergunta nas respostas seguintes.`;

// Uma pergunta feita há mais tempo que isso pode ser retomada normalmente.
export const PERGUNTA_PENDENTE_MAX_HORAS = 12;

function textoDaMensagem(raw) {
    const s = String(raw || '').trim();
    if (!s || s.startsWith('[FILE:')) return '';
    return s;
}

// 'YYYY-MM-DD HH:MM:SS' (UTC, como o banco grava) -> ms. NaN se não der pra ler.
function tsParaMs(ts) {
    if (!ts) return NaN;
    return Date.parse(String(ts).replace(' ', 'T') + 'Z');
}

// Última frase interrogativa de um texto ("Sem problemas! Prefere manhã ou tarde?"
// -> "Prefere manhã ou tarde?").
export function extrairPergunta(texto) {
    const frases = String(texto || '').replace(/\s+/g, ' ').match(/[^.!?…]*\?+/g);
    if (!frases || !frases.length) return '';
    return frases[frases.length - 1].trim();
}

// rows: mensagens em ordem cronológica, { direction: 'in'|'out', message, timestamp }.
// Devolve a última pergunta que a clínica fez e o que o paciente escreveu
// depois dela, ou null se não há pergunta recente.
export function ultimaPerguntaFeita(rows, agoraMs = Date.now()) {
    const lista = Array.isArray(rows) ? rows : [];
    for (let i = lista.length - 1; i >= 0; i--) {
        const r = lista[i];
        if (r.direction !== 'out') continue;
        const pergunta = extrairPergunta(textoDaMensagem(r.message));
        if (!pergunta) continue;
        const feitaEm = tsParaMs(r.timestamp);
        if (Number.isFinite(feitaEm) && agoraMs - feitaEm > PERGUNTA_PENDENTE_MAX_HORAS * 3600 * 1000) return null;
        const depois = lista.slice(i + 1)
            .filter(x => x.direction === 'in')
            .map(x => textoDaMensagem(x.message))
            .filter(Boolean);
        return { pergunta, depois };
    }
    return null;
}

// Bloco dinâmico do prompt: mostra à IA, com todas as letras, a pergunta que
// ela mesma já fez e o que o paciente escreveu depois. Quem decide se aquilo
// responde ou não a pergunta é o modelo — aqui só se garante que ele veja.
export function perguntaPendenteRule(rows, agoraMs = Date.now()) {
    const p = ultimaPerguntaFeita(rows, agoraMs);
    if (!p || !p.depois.length) return '';
    const cortar = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
    const falas = p.depois.slice(-4).map(t => `"${cortar(t, 200)}"`).join(' / ');
    return `

[SUA ÚLTIMA PERGUNTA] Você já perguntou ao paciente: "${cortar(p.pergunta, 300)}"
Depois disso ele escreveu: ${falas}
- Se isso RESPONDE a sua pergunta, siga a conversa a partir da resposta dele.
- Se NÃO responde (ele pediu outra coisa, fez outra pergunta ou disse que vai ver/confirmar depois), a pergunta continua pendente e visível pra ele: atenda só o que ele pediu agora, NÃO refaça essa pergunta nem uma parecida, e termine a resposta SEM pergunta.`;
}
