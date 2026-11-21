// outbound-sequencer: cold email sequencer on Cloudflare Workers + D1. Sanitized public copy: brands, addresses and credentials replaced with placeholders.
// Every rule here comes from "Mailbox sequencer deliverability build" (2026-10-19) and its gap brief.
// Nothing reaches a new prospect unless the operator approved the batch. Code changes drop the system to dry-run until re-armed.

const ET = 'America/New_York';
const ZAPI = 'https://mail.provider.example/api', ZACC = 'https://accounts.provider.example';
const RAMP = [2, 4, 7, 10, 15, 20, 25];               // daily cap per inbox, advanced on evidence only (r31, the operator 2026-10-29: research ramp, ceiling 25 on Mailbox)
const STEP_DAYS_AT = [5, 5, 5, 5, 5, 5];             // clean sending days needed at step i before moving to i+1 (one sending week)
const STEP_DAYS = 10;                                // clean sending days required at a step before moving up
const STEP_OFFSETS = [0, 3, 7, 14];                  // business days after step 0
const MIN_GAP = 8 * 60000;                           // per-inbox minimum gap between sends
const WINDOWS = [[8 * 60 + 30, 11 * 60 + 30], [13 * 60, 15 * 60 + 30]];   // recipient-local minutes
const FALLBACK_WIN = [[10 * 60, 16 * 60]];           // ET, when the recipient's zone is unknown
// Signature + legal footer (the operator 21 Oct: proper signature; bodies end WITHOUT a sign-off, the footer signs as Alex Operator / Brand A Websites).
const FOOTER = '\n\nAlex Operator\nBrand A Websites\n555-010-0100\n\n--\n123 Example St, Los Angeles, CA 90001\nNot relevant? Reply "stop" and I won\'t email again.';
const DIGEST_TO = 'alerts@example.com', DIGEST_FROM = 'owner@example.com';
const SEEDS = ['owner@example.com', 'founder@example.org'];   // Google Workspace seeds the service account can read
const POLL_PER_TICK = 9, POLL_ZCALLS = 13;   // r26: 9 inboxes per tick so all 27 are read within ~30 min (a stranger's message on ANY inbox pauses sending: sendOne holds while any inbox is unread for 45 min)            // poll rotation: 7 inboxes per 5-min tick (each box every ~20 min), leaves Mailbox calls for sending
const FETCH_BUDGET = 32;                             // free plan: 50 subrequests per invocation (D1 calls take the rest)
// Public holidays per recipient country, computed for any year (cold mail is never sent on the recipient's holiday or Dec 24 - Jan 1).
function easter(y) { const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451), mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1; return `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`; }
function nthDow(y, m, wd, n) { const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); let d = 1 + ((wd - first + 7) % 7) + (n - 1) * 7; return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
function lastDow(y, m, wd) { const last = new Date(Date.UTC(y, m, 0)); const d = last.getUTCDate() - ((last.getUTCDay() - wd + 7) % 7); return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
function dowBetween(y, m, from, to, wd) { for (let d = from; d <= to; d++) if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === wd) return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
function orthEaster(y) { const a = y % 4, b = y % 7, c = y % 19, d = (19 * c + 15) % 30, e = (2 * a + 4 * b - d + 34) % 7, mo = Math.floor((d + e + 114) / 31), da = ((d + e + 114) % 31) + 1; const t = new Date(Date.UTC(y, mo - 1, da + 13)); return t.toISOString().slice(0, 10); }   // Julian computus + 13 days (1900-2099)
const HCACHE = new Map();
function holidays(cc, y) {
  const key = cc + y; if (HCACHE.has(key)) return HCACHE.get(key);
  const e = easter(y), E = n => { const t = new Date(e + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const oe = orthEaster(y), O = n => { const t = new Date(oe + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const f = (m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const obs = d => { const w = new Date(d + 'T12:00:00Z').getUTCDay(); const t = new Date(d + 'T12:00:00Z'); if (w === 6) t.setUTCDate(t.getUTCDate() - 1); if (w === 0) t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
  const L = {
    US: [obs(f(1, 1)), nthDow(y, 1, 1, 3), nthDow(y, 2, 1, 3), lastDow(y, 5, 1), obs(f(6, 19)), obs(f(7, 4)), nthDow(y, 9, 1, 1), nthDow(y, 10, 1, 2), obs(f(11, 11)), nthDow(y, 11, 4, 4), (() => { const t = new Date(nthDow(y, 11, 4, 4) + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); })(), obs(f(12, 25))],
    CA: [f(1, 1), E(-2), dowBetween(y, 5, 18, 24, 1), f(7, 1), nthDow(y, 8, 1, 1), nthDow(y, 9, 1, 1), f(9, 30), nthDow(y, 10, 1, 2), f(11, 11), f(12, 25), f(12, 26)],
    GB: [f(1, 1), E(-2), E(1), nthDow(y, 5, 1, 1), lastDow(y, 5, 1), lastDow(y, 8, 1), f(12, 25), f(12, 26), f(12, 28)],
    IE: [f(1, 1), new Date(Date.UTC(y, 1, 1)).getUTCDay() === 5 ? f(2, 1) : nthDow(y, 2, 1, 1), f(3, 17), E(1), nthDow(y, 5, 1, 1), nthDow(y, 6, 1, 1), nthDow(y, 8, 1, 1), lastDow(y, 10, 1), f(12, 25), f(12, 26)],
    FR: [f(1, 1), E(1), f(5, 1), f(5, 8), E(39), E(50), f(7, 14), f(8, 15), f(11, 1), f(11, 11), f(12, 25)],
    SK: [f(1, 1), f(1, 6), E(-2), E(1), f(5, 1), f(5, 8), f(7, 5), f(8, 29), f(9, 1), f(9, 15), f(11, 1), f(11, 17), f(12, 24), f(12, 25), f(12, 26)],
    FI: [f(1, 1), f(1, 6), E(-2), E(1), f(5, 1), E(39), dowBetween(y, 6, 19, 25, 5), f(12, 6), f(12, 24), f(12, 25), f(12, 26)],
    SE: [f(1, 1), f(1, 6), E(-2), E(1), f(5, 1), E(39), f(6, 6), dowBetween(y, 6, 19, 25, 5), f(12, 24), f(12, 25), f(12, 26), f(12, 31)],
    BE: [f(1, 1), E(1), f(5, 1), E(39), E(50), f(7, 21), f(8, 15), f(11, 1), f(11, 11), f(12, 25)],
    NO: [f(1, 1), E(-3), E(-2), E(1), f(5, 1), f(5, 17), E(39), E(50), f(12, 25), f(12, 26)],
    SI: [f(1, 1), f(1, 2), f(2, 8), E(1), f(4, 27), f(5, 1), f(5, 2), f(6, 25), f(8, 15), f(10, 31), f(11, 1), f(12, 25), f(12, 26)],
    EE: [f(1, 1), f(2, 24), E(-2), f(5, 1), f(6, 23), f(6, 24), f(8, 20), f(12, 24), f(12, 25), f(12, 26)],
    HU: [f(1, 1), f(3, 15), E(-2), E(1), f(5, 1), E(50), f(8, 20), f(10, 23), f(11, 1), f(12, 24), f(12, 25), f(12, 26)],
    DE: [f(1, 1), E(-2), E(1), f(5, 1), E(39), E(50), E(60), f(10, 3), f(10, 31), f(11, 1), f(12, 25), f(12, 26)],
    NL: [f(1, 1), E(-2), E(1), new Date(Date.UTC(y, 3, 27)).getUTCDay() === 0 ? f(4, 26) : f(4, 27), f(5, 5), E(39), E(50), f(12, 25), f(12, 26)],
    ES: [f(1, 1), f(1, 6), E(-3), E(-2), E(1), f(5, 1), f(8, 15), f(10, 12), f(11, 1), f(12, 6), f(12, 8), f(12, 25)],
    IT: [f(1, 1), f(1, 6), E(1), f(4, 25), f(5, 1), f(6, 2), f(8, 15), f(10, 4), f(11, 1), f(12, 8), f(12, 25), f(12, 26)],
    AT: [f(1, 1), f(1, 6), E(1), f(5, 1), E(39), E(50), E(60), f(8, 15), f(10, 26), f(11, 1), f(12, 8), f(12, 25), f(12, 26)],
    CH: [f(1, 1), f(1, 2), E(-2), E(1), E(39), E(50), f(8, 1), f(12, 25), f(12, 26)],
    CZ: [f(1, 1), E(-2), E(1), f(5, 1), f(5, 8), f(7, 5), f(7, 6), f(9, 28), f(10, 28), f(11, 17), f(12, 24), f(12, 25), f(12, 26)],
    PL: [f(1, 1), f(1, 6), E(1), f(5, 1), f(5, 3), E(60), f(8, 15), f(11, 1), f(11, 11), f(12, 24), f(12, 25), f(12, 26)],
    DK: [f(1, 1), E(-3), E(-2), E(1), E(39), E(40), E(50), f(6, 5), f(12, 24), f(12, 25), f(12, 26), f(12, 31)],
    PT: [f(1, 1), E(-47), E(-2), f(4, 25), f(5, 1), E(60), f(6, 10), f(8, 15), f(10, 5), f(11, 1), f(12, 1), f(12, 8), f(12, 25)],
    LU: [f(1, 1), E(1), f(5, 1), f(5, 9), E(39), E(50), f(6, 23), f(8, 15), f(11, 1), f(12, 25), f(12, 26)],
    LT: [f(1, 1), f(2, 16), f(3, 11), E(1), f(5, 1), f(6, 24), f(7, 6), f(8, 15), f(11, 1), f(11, 2), f(12, 24), f(12, 25), f(12, 26)],
    LV: [f(1, 1), E(-2), E(1), f(5, 1), f(5, 4), f(6, 23), f(6, 24), f(11, 18), f(12, 24), f(12, 25), f(12, 26), f(12, 31)],
    HR: [f(1, 1), f(1, 6), E(1), f(5, 1), f(5, 30), E(60), f(6, 22), f(8, 5), f(8, 15), f(11, 1), f(11, 18), f(12, 25), f(12, 26)],
    RO: [f(1, 1), f(1, 2), f(1, 6), f(1, 7), f(1, 24), O(-2), O(1), f(5, 1), f(6, 1), O(50), f(8, 15), f(11, 30), f(12, 1), f(12, 25), f(12, 26)],
    BG: [f(1, 1), f(3, 3), O(-2), O(1), f(5, 1), f(5, 6), f(5, 24), f(9, 6), f(9, 22), f(12, 24), f(12, 25), f(12, 26)],
    GR: [f(1, 1), f(1, 6), O(-48), f(3, 25), O(-2), O(1), f(5, 1), O(50), f(8, 15), f(10, 28), f(12, 25), f(12, 26)],
  };
  const out = new Set((L[cc] || (cc === 'US' || !cc ? L.US : [])).filter(Boolean));
  for (let d = 24; d <= 31; d++) out.add(f(12, d)); out.add(f(1, 1));   // quiet period for everyone
  HCACHE.set(key, out); return out;
}
const STOP_RX = /\b((?<!\b(customers|clients|subscribers|users|readers|people|members|clientes|subscritores|leitores)\b[^.!?\n]{0,25})unsubscribe(?![^.!?\n]{0,40}\b(for|in|on|to|from) (our|my) (own )?(newsletter|mailing|site|website|customers|clients|subscribers|shop|store|tool|list)\b)|(?<!\b(n[ãa]o|nunca|sem)\s(\S+\s)?)(deixar|parar) de receber (mais )?((a |as |os |o )?(vossa|vosso|vossos|vossas|seus|suas|teus|tuas|sua|seu|tua|teu) (e-?mails?|mensagens|campanhas|newsletters?|comunica[çc][\wÀ-ɏ]*|publicidade)|(os |as )?(e-?mails?|mensagens|campanhas|newsletters?|comunica[çc][\wÀ-ɏ]*|publicidade) (vossos|vossas|seus|suas|teus|tuas|de voc[êe]s|vossos)\b|(estes|esses|estas|essas) (e-?mails?|mensagens|campanhas|newsletters?|comunica[çc][\wÀ-ɏ]*|publicidade)(?! d[eo]s?\b)|mais (e-?mails?|mensagens|campanhas|newsletters?|comunica[çc][\wÀ-ɏ]*|publicidade)(?! d[eo]s?\b)(?![^.!?\n]{0,40}\b(sobre (spam|o formul|o site)|de spam|spam)\b)|(e-?mails?|mensagens|campanhas|newsletters?|comunica[çc][\wÀ-ɏ]*|publicidade) de voc[êe]s)(?![^.!?]{0,60}\b(form\w*|formul[áa]rio|captcha|filtros?|gmail|google|outlook|banco)\b)|remove me(?!\s+from (the |this )?(cc|copy)\b)|remove my (address|email|e-mail|details)(?![^.!?]{0,30}\bfrom (the|our|my) (old |current |existing )?(site|website|footer|page|listing|directory|google|contact page|booking)\b)|n[ãa]o (me |nos )?(mandem|mande|mandar|enviar) mais(?!\s+(?!(e-?mails?|mails?|mensage\w*|correios?|nada(?! em)|coisas?|publicidade|spam|newsletters?|informa\w*|propostas?(?! gen)|campanhas?|isto|isso|disto|disso|contactos?)\b)[\wÀ-ɏ]+( [\wÀ-ɏ]+){0,3}\s*[,;.]\s*[^\n]{0,60}?(\b(mande|envie|mandem|enviem)(-me|-nos)?\s+(o|a|os|as|um|uma|s[óo]|apenas|antes)(?![\wÀ-ɏ])|\bescrev\w* em portugu|\bquanto (custa|fica|cobra)))(?![^.!?\n]{0,50}?(?<!(\w+n't|\b(dont|wont|cant|not|nor|or|nem|n[ãa]o|never))\s((by|via|on|in|por|pelo|pela|no|na)\s)?)\b((call|ring|phone|text|whatsapp) (me|us)\b|whatsapp\b|lig(ue|uem|a)-(me|nos)\b|liguem? para\b|prefiro (falar )?(ao|por) telefone))|(?<!\b(clientes|pacientes|pessoas|utentes|alunos|h[óo]spedes|eles|elas|fornecedores|spammers|bots|rob[ôo]s)\s)deix(?!aram|ou\b|[áa]mos|ei\b|avam|ava\b)\w+ de (me |nos )?contactar|n[ãa]o (me |nos )?(voltem?|voltes|voltasse) a (contactar|contatar|enviar|mandar|escrever|incomodar)(?!\s+para\s+(o|a|esse|este|aquele)\s+(e-?mail|endere[çc]o)\s+(antigo|anterior|velho)\b)(?!\w*\s+(a|o) (proposta|or[çc]amento|contrato|fatura|documento|amostra)\b[^]{0,60}\b(j[áa] (a|o) (tenho|recebi)|aceit\w+|avan[çc]\w+|combinado|fechado)\b)|escus\w+ de (me |nos )?(enviar|mandar|contactar|contatar|escrever)( mais)?( e-?mails?| mensagens| propostas| nada)?(?=\s*([.!,;]|$))(?!(?![^.!?]{0,80}\b(n[ãa]o|nunca|nem|never|not)\b)[^.!?]{0,80}\b(convencid[oa]s?|decidid[oa]s?|aceito|aceitamos|avan[çc]\w+|fechado|combinado|j[áa] (vi|tenho|recebi)|quando come[çc]amos)\b)|escus\w+ de insistir|n[ãa]o (é|e) do nosso interesse(?!\s+(ficar|continuar|estar) sem (site|website|presen))(?!(?<=\b(loja|blog|e-?commerce|redes sociais|app|newsletter)( online| virtual)?[,:]?\s+n[ãa]o (é|e) do nosso interesse)[\s,;]*(mas|but|s[óo]|apenas)(?![\wÀ-ɏ]))|n[ãa]o (temos|tenho) necessidade(?!\s+de (esperar|aguardar|adiar|pensar|reunir|mais tempo|perder tempo|ver mais|falar mais)\b)(?!\s+(em |in |n[ao] |numa? |de )?(a |o |the |an? |uma |um )?(loja online|loja virtual|loja|blog|e-?commerce|online shop|shop|newsletter|redes sociais|app)\b[^.!?]{0,40}\b(s[óo]|apenas|just|only|though)(?![\wÀ-ɏ]))|n[ãa]o precisamos de (um |de )?(site|websites?|novo site)(?!\s+(para j[áa]|agora|de momento|neste momento|por agora|por enquanto)(?![\wÀ-ɏ])[^.!?]{0,20}\b(mas|but)\b(?![^.!?]{0,60}\b(n[ãa]o|nem|never|don'?t|do not)\s+(me |nos |us )?(fal|contact|volt|lig|escrev|envi|mand|insist|call|write|email)\w*)[^.!?]{0,60}\b(fal\w+|contact\w*|volt\w*|ligu\w*|escrev\w*|janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|para o ano|mais tarde|depois)\b)(?![^]{0,200}?(\b(precisamos|queremos|gostar\w*|apenas|mas|but|just|only)\b|\bs[óo](?![\wÀ-ɏ]))(?![^]{0,160}?(\bem paz\b|\bsossego\b|\bpar(e|em|am|ar) de (nos|me) (enviar|mandar|escrever|contactar|incomodar)|\bdeix(e|em|ar|am) de (nos|me) (enviar|mandar|escrever|contactar)))[^]{0,160}?\?)|don'?t write (to us |to me )?again|remove us from (your|the|this) (mailing |email |e-mail )?(list|emails?|database|contacts)|(?<!\b(clientes|pacientes|pessoas|utentes|alunos|h[óo]spedes|eles|elas|fornecedores|spammers|bots|rob[ôo]s)\s)deixem? de (nos |me )?enviar|n[ãa]o (tenho|temos) qualquer interesse(?!(\s+nenhum)?\s+em (continuar|ficar|manter)(-nos)? (com|no|na) (o |a )?(wix|squarespace|godaddy|shopify|wordpress|hostinger|jimdo|weebly|webnode|site (atual|antigo)|atual|antig\w+|meu|minha|nosso|nossa)\b)(?!\s+(em |in |n[ao] |numa? |de )?(a |o |the |an? |uma |um )?(loja online|loja virtual|loja|blog|e-?commerce|online shop|shop|newsletter|redes sociais|app)\b[^.!?]{0,40}\b(s[óo]|apenas|just|only|though)(?![\wÀ-ɏ]))|desinscrev\w*|n[ãa]o estamos (à|a) procura d\w+ (um |uma )?(site|website|novo site)(?!\s+(car[oa]s?|complicad\w*|enorme|grande|de luxo|premium|com loja|cheio)\b)|take (me|us) off(?!\s+(the|our|that) (waiting ?list|wait-?list|old (directory|listing)|directory|listing|old site)\b)(?![^.!?]{0,60}\band (put|add|move) (me|us)\b(?![^.!?]{0,40}\b(do[- ]not|suppression|black ?list|block\w*|opt[- ]?out|unsubscrib\w*)))(?!\s+(the )?(phone|telephone|hook|telefone)\b(?![^.!?\n]{0,40}\b(lists?|e-?mails?|mailing|database|contacts|registry)\b))|not interested(?!\s+(em|in|n[oa]s?|numa?|on|about|for)\s+(a |an |uma |um |the |any |phone |telephone |short |quick |video |zoom )*(calls?|chamadas?|telefonemas?|liga[çc][õo]es|liga[çc][ãa]o|reuni[ãa]o|reuni[õo]es|meetings?)\b(?![^]{0,160}?(\b(not|nor|neither|nem|n[ãa]o)\s+((by|via|por|in|em|n[oa]s?|an?|um|uma|the|o|a|through)\s+){0,2}(e-?mails?|escrito|writing|websites?|sites?|anything|nada)\b|\b(e-?mails?|escrito)\s+(tamb[ée]m|tampouco)\s+n[ãa]o\b|\bleave (me|us) (alone|be)\b|\bem paz\b|\bsossego\b|\b(this|it) to (end|stop)\b|\b(but|mas)\s+(thanks?|thank you|obrigad[oa])( na mesma| anyway| though| de qualquer forma)?[\s.!]*$))[^]{0,160}?(\b(mas|but|por[ée]m|just|only|apenas|instead|envi(e|em|ar|a)|mand(e|em|ar|a)|send|in writing|email me|e-mail me|prefer\w*|prefiro)\b|\bs[óo](?![\wÀ-ɏ])|\b(por|by|via) (e-?mail|escrito|writing)\b))(?!\s+(em|in|n[oa]s?|about|on)\s[^.!?\n]{1,60}[.!?,;:]+(?![^]{0,160}?(\bhow much (clearer|more|longer|plainer)\b|\b(pay|paid|pagou|pagaram|pagam|pago)\b[^?\n]{0,30}\b(e-?mail|address|endere[çc]o|contacto|dados|data)\b|\bquanto (é que )?(é )?preciso\b|\bem paz\b|\balone\b))[^]{0,160}?(quanto (custa|fica|seria|cobra\w*|[ée])|qual (é |e )?(o )?(pre[çc]o|valor|custo)|or[çc]amento|how much|what (would|does|will|is) [^?\n]{0,40}(cost|price)|\bquote\b|\bprice\b|pre[çc]o)[^.!\n]{0,60}\?)(?!\s+(em |in |n[ao] |numa? |de )?(a |o |the |an? |uma |um )?(loja online|loja virtual|loja|blog|e-?commerce|online shop|shop|newsletter|redes sociais|app)\b[^.!?]{0,40}\b(s[óo]|apenas|just|only|though)(?![\wÀ-ɏ]))|(do not|don'?t) (contact|email|e-mail|message) (me|us)\b(?!\s+(before|after|during|between|until|till)\b)(?!\s+(on (mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays|weekends|the weekend)|in the (morning|afternoon|evening)|at lunch(time)?|today|tomorrow|this week)\b(?![^.!?]{0,30}\b(or any|ever|again|any ?more)\b))(?!\s+(at|on|via|instead|directly|here|there|through)\b(?=[^]{0,120}?(@|\d{3})|[^.!?\n]{0,120}?(?<!(\w+n't|\b(dont|wont|cant|not|nor|or|nem|n[ãa]o|never))\s((by|via|on|in|por|pelo|pela|no|na)\s)?)\b(instead|use|write|send|talk|speak|reach|contact|call|ring|phone|text|whatsapp|e-?mail( me| us| is| only| instead)|(by|por|via) e-?mail|my (assistant|secretary|colleague|partner|office|manager|son|daughter|wife|husband))\b))(?![^.!?\n]{0,50}?(?<!(\w+n't|\b(dont|wont|cant|not|nor|or|nem|n[ãa]o|never))\s((by|via|on|in|por|pelo|pela|no|na)\s)?)\b((call|ring|phone|text|whatsapp) (me|us)\b|whatsapp\b|lig(ue|uem|a)-(me|nos)\b|liguem? para\b|prefiro (falar )?(ao|por) telefone))|(do not|don'?t|never) (contact|e-?mail|message)( me| us)?( here| there| at this (e-?mail )?(address|e-?mail)| (through|via|on|to|at) this (e-?mail|address|inbox)( address)?)? again(?![^.!?\n]{0,50}?(?<!(\w+n't|\b(dont|wont|cant|not|nor|or|nem|n[ãa]o|never))\s((by|via|on|in|por|pelo|pela|no|na)\s)?)\b((call|ring|phone|text|whatsapp) (me|us)\b|whatsapp\b|lig(ue|uem|a)-(me|nos)\b|liguem? para\b|prefiro (falar )?(ao|por) telefone))|no more (e-?mails|messages)\b(?!\s*,?\s*(just|only|apenas|s[óo]|needed|necess)(?![^.!?\n]{0,30}\b(alone|paz|silence|sil[êe]ncio|sossego|ever(?! since)|nunca|stop|parem?)\b))(?!\s+(from|through|via|on|in)\s+(it|them|(the |our |my |this )?(contact |booking |web ?site |website )?(form|site|website|inbox|page|system))\b(?![^.!?\n]{0,30}\bfrom (you|your|this (address|sender|company))\b))(?![^.!?\n]{0,50}?(?<!(\w+n't|\b(dont|wont|cant|not|nor|or|nem|n[ãa]o|never))\s((by|via|on|in|por|pelo|pela|no|na)\s)?)\b((call|ring|phone|text|whatsapp) (me|us)\b|whatsapp\b|lig(ue|uem|a)-(me|nos)\b|liguem? para\b|prefiro (falar )?(ao|por) telefone))|(?<!\b(he|she|they|designer|developer|guy|agency|company|clients|customers|people|it|programmer)\s)quit (e-?mailing|contacting|messaging|sending|spamming)(?!\s+(me|us) back\b)|delete my (data|details)|d[ée]sabonn\w*|d[ée]sinscri\w*|pas int[ée]ress\w*|retirez|supprimez|ne (plus )?(me )?(contacter|[ée]crire)|avregistrera|inte intresserad|ta bort mig|ei kiinnosta|poista minut|odhl[áa]si\w*|nem[áa]m z[áa]ujem|nekontaktujte|ikke interessert|meld meg av|nem [ée]rdekel|leiratkoz\w*|ei ole huvitatud|ni zanimanja|odjava|uitschrijven|abmelden|austragen|kein interesse|nicht interessiert|keine (werbung|e-?mails?)|afmelden|geen interesse|darme de baja|dar de baja|no me interesa|no estoy interesad\w*|cancellami|cancellatemi|disiscriv\w*|non (sono )?interessat\w*|non mi interessa|odhl[áa]sit|nem[áa]m z[áa]jem|nezaj[íi]m[áa]|wypisz|nie jestem zainteresowan\w*|rezygnuj\w*|afmeld\w*|ikke interesseret|descadastr\w*|n[ãa]o (tenho |temos |h[áa] |me |nos )?interess\w*(?!(\s+nenhum)?\s+em (continuar|ficar|manter)(-nos)? (com|no|na) (o |a )?(wix|squarespace|godaddy|shopify|wordpress|hostinger|jimdo|weebly|webnode|site (atual|antigo)|atual|antig\w+|meu|minha|nosso|nossa)\b)(?!\s+(em|in|n[oa]s?|numa?|on|about|for)\s+(a |an |uma |um |the |any |phone |telephone |short |quick |video |zoom )*(calls?|chamadas?|telefonemas?|liga[çc][õo]es|liga[çc][ãa]o|reuni[ãa]o|reuni[õo]es|meetings?)\b(?![^]{0,160}?(\b(not|nor|neither|nem|n[ãa]o)\s+((by|via|por|in|em|n[oa]s?|an?|um|uma|the|o|a|through)\s+){0,2}(e-?mails?|escrito|writing|websites?|sites?|anything|nada)\b|\b(e-?mails?|escrito)\s+(tamb[ée]m|tampouco)\s+n[ãa]o\b|\bleave (me|us) (alone|be)\b|\bem paz\b|\bsossego\b|\b(this|it) to (end|stop)\b|\b(but|mas)\s+(thanks?|thank you|obrigad[oa])( na mesma| anyway| though| de qualquer forma)?[\s.!]*$))[^]{0,160}?(\b(mas|but|por[ée]m|just|only|apenas|instead|envi(e|em|ar|a)|mand(e|em|ar|a)|send|in writing|email me|e-mail me|prefer\w*|prefiro)\b|\bs[óo](?![\wÀ-ɏ])|\b(por|by|via) (e-?mail|escrito|writing)\b))(?!\s+(em|in|n[oa]s?|about|on)\s[^.!?\n]{1,60}[.!?,;:]+(?![^]{0,160}?(\bhow much (clearer|more|longer|plainer)\b|\b(pay|paid|pagou|pagaram|pagam|pago)\b[^?\n]{0,30}\b(e-?mail|address|endere[çc]o|contacto|dados|data)\b|\bquanto (é que )?(é )?preciso\b|\bem paz\b|\balone\b))[^]{0,160}?(quanto (custa|fica|seria|cobra\w*|[ée])|qual (é |e )?(o )?(pre[çc]o|valor|custo)|or[çc]amento|how much|what (would|does|will|is) [^?\n]{0,40}(cost|price)|\bquote\b|\bprice\b|pre[çc]o)[^.!\n]{0,60}\?)(?!\s+(o |a )?(pre[çc]o|custo|valor)\b)(?!\s+(em |in |n[ao] |numa? |de )?(a |o |the |an? |uma |um )?(loja online|loja virtual|loja|blog|e-?commerce|online shop|shop|newsletter|redes sociais|app)\b[^.!?]{0,40}\b(s[óo]|apenas|just|only|though)(?![\wÀ-ɏ]))|sem interesse(?!\s+(em|n[ao]s?)\s+(a |o |as |os )?(loja online|loja virtual|loja|blog|e-?commerce|newsletter|redes sociais|app|instagram|facebook)\b[^.!?]{0,40}\b(mas|s[óo]|apenas)\b)(?!(?<=\b(loja|blog|e-?commerce|redes sociais|app|newsletter)( online| virtual)?[,:]?\s+sem interesse)[\s.,;]*[^.!?]{0,40}\b(sim|s[óo]|apenas|mas)(?![\wÀ-ɏ]))(?!\s+(em|in|n[oa]s?|numa?|on|about|for)\s+(a |an |uma |um |the |any |phone |telephone |short |quick |video |zoom )*(calls?|chamadas?|telefonemas?|liga[çc][õo]es|liga[çc][ãa]o|reuni[ãa]o|reuni[õo]es|meetings?)\b(?![^]{0,160}?(\b(not|nor|neither|nem|n[ãa]o)\s+((by|via|por|in|em|n[oa]s?|an?|um|uma|the|o|a|through)\s+){0,2}(e-?mails?|escrito|writing|websites?|sites?|anything|nada)\b|\b(e-?mails?|escrito)\s+(tamb[ée]m|tampouco)\s+n[ãa]o\b|\bleave (me|us) (alone|be)\b|\bem paz\b|\bsossego\b|\b(this|it) to (end|stop)\b|\b(but|mas)\s+(thanks?|thank you|obrigad[oa])( na mesma| anyway| though| de qualquer forma)?[\s.!]*$))[^]{0,160}?(\b(mas|but|por[ée]m|just|only|apenas|instead|envi(e|em|ar|a)|mand(e|em|ar|a)|send|in writing|email me|e-mail me|prefer\w*|prefiro)\b|\bs[óo](?![\wÀ-ɏ])|\b(por|by|via) (e-?mail|escrito|writing)\b))|n[ãa]o pretend\w* (receber|ser contactad\w*|mais(?!\s+(pagar|gastar|usar|depender|esperar|aguardar|adiar|perder)\b)|continuar(?!\s+(sem (site|website|p[áa]gina|presen[çc]a)|assim|a (perder|esperar)|com (o|a) (wix|squarespace|godaddy|shopify|wordpress|mesm[oa]|atual|nossa|nosso|ag[êe]ncia|empresa|programador)|a (pagar|usar|depender)|pagando|usando|dependendo)\b))|remov\w*(-me|-nos)?( o (meu|nosso) (e-?mail|contacto|endere[çc]o)| da (vossa |sua )?lista)|remov\w*-(me|nos)\b|(remov|retir|tir|apag|exclu)\w*( o| a)? (meu|nosso|minha) (e-?mail|contacto|contato|endere[çc]o) d[aeo]s?s?[ae]? (vossa |sua |tua |vosso |seu )?(lista|mailing|base|cadastro)|(me|nos) (tir|retir|remov|exclu)\w* d[aeo]s?s?[ae]? (vossa |sua |tua |vosso |seu )?(lista|mailing|base|cadastro)|(tir|retir)\w*-(me|nos) d[ae] (vossa |sua )?(lista|mailing|base de dados)|(tir|retir)\w*-(me|nos)\b(?=\s*[.!]?\s*$)|cancel\w* (a )?subscri[çc][ãa]o(?!\s+(d[aeo]s?|no|na|ao)\s+(wix|squarespace|godaddy|shopify|wordpress|hostinger|jimdo|weebly|webnode|site antigo|plano|alojamento|dom[íi]nio|antig[oa]|atual|outr[oa]|ferramenta|programa)\b)|n[ãa]o (voltem?|volte) a (contactar|enviar|escrever)\w*(?!\s+(a|o) (proposta|or[çc]amento|contrato|fatura|documento|amostra)\b[^]{0,60}\b(j[áa] (a|o) (tenho|recebi)|aceit\w+|avan[çc]\w+|combinado|fechado)\b)|apag(?!(ou|iu|aram|iram|ava|avam|ado|ada|ados|adas|ido|ida)\b)\w* (os )?(meus|nossos) dados|(remov|retir)\w* (os )?(meus|nossos) dados( pessoais)?(?=\s*([.!,;]|por favor|$))|n[ãa]o (me |nos )?(escreva|escrevam) mais(?!\s+(em|in)\s)|elimin(?!(ou|iu|aram|iram|ava|avam|ado|ada|ados|adas|ido|ida)\b)\w* (os )?(meus|nossos) dados|n[ãa]o (estou|estamos) interessad\w*(?!\s+(em |in |n[ao] |numa? |de )?(a |o |the |an? |uma |um )?(loja online|loja virtual|loja|blog|e-?commerce|online shop|shop|newsletter|redes sociais|app)\b[^.!?]{0,40}\b(s[óo]|apenas|just|only|though)(?![\wÀ-ɏ]))(?!\s+(em|in|n[oa]s?|numa?|on|about|for)\s+(a |an |uma |um |the |any |phone |telephone |short |quick |video |zoom )*(calls?|chamadas?|telefonemas?|liga[çc][õo]es|liga[çc][ãa]o|reuni[ãa]o|reuni[õo]es|meetings?)\b(?![^]{0,160}?(\b(not|nor|neither|nem|n[ãa]o)\s+((by|via|por|in|em|n[oa]s?|an?|um|uma|the|o|a|through)\s+){0,2}(e-?mails?|escrito|writing|websites?|sites?|anything|nada)\b|\b(e-?mails?|escrito)\s+(tamb[ée]m|tampouco)\s+n[ãa]o\b|\bleave (me|us) (alone|be)\b|\bem paz\b|\bsossego\b|\b(this|it) to (end|stop)\b|\b(but|mas)\s+(thanks?|thank you|obrigad[oa])( na mesma| anyway| though| de qualquer forma)?[\s.!]*$))[^]{0,160}?(\b(mas|but|por[ée]m|just|only|apenas|instead|envi(e|em|ar|a)|mand(e|em|ar|a)|send|in writing|email me|e-mail me|prefer\w*|prefiro)\b|\bs[óo](?![\wÀ-ɏ])|\b(por|by|via) (e-?mail|escrito|writing)\b))(?!\s+(em|in|n[oa]s?|about|on)\s[^.!?\n]{1,60}[.!?,;:]+(?![^]{0,160}?(\bhow much (clearer|more|longer|plainer)\b|\b(pay|paid|pagou|pagaram|pagam|pago)\b[^?\n]{0,30}\b(e-?mail|address|endere[çc]o|contacto|dados|data)\b|\bquanto (é que )?(é )?preciso\b|\bem paz\b|\balone\b))[^]{0,160}?(quanto (custa|fica|seria|cobra\w*|[ée])|qual (é |e )?(o )?(pre[çc]o|valor|custo)|or[çc]amento|how much|what (would|does|will|is) [^?\n]{0,40}(cost|price)|\bquote\b|\bprice\b|pre[çc]o)[^.!\n]{0,60}\?)|n[ãa]o (quero|queremos|desejo|desejamos) ((mais )?receber(?!\s+(mais\s+)?(or[çc]amentos|marca[çc][õo]es|reservas|pagamentos|encomendas|pedidos(?! de (reuni|chamada|contacto))|notifica[\wÀ-ɏ]*|confirma[\wÀ-ɏ]*|faturas|(chamadas|telefonemas|liga[çc][õo]es)(?![^.!?]{0,30}(?<!\b(prefiro|preferimos|prefere|por|via|pelo)\s(o |um )?)\b(e-?mails?|nem|vossos|vossas|vosso|de voc[êe]s)\b))(?![\wÀ-ɏ])(?!\s+(vossas?|vossos?|suas|seus|de voc[êe]s|da vossa|da sua)\b))|ser contactad\w*|mais (e-?mails?|mensagens(?!\s+(no|do|pelo|pela|via|de clientes)\s+(instagram|facebook|whatsapp|messenger|telefone)\b)|contactos|publicidade|nada))|n[ãa]o (me |nos )?(contacte|contactem)\b(?!\s+para o (fixo|telefone fixo|n[úu]mero (fixo|antigo))\b)(?!\s+(por|pelo|pela|via)\s+(telefone|telem[óo]vel|celular|chamadas?|sms|mensagens? de texto)\b(?![^.!?\n]{0,40}\b(nem|or|ou|e)\s+(por\s+|pelo\s+|via\s+)?e-?mail))(?!\s+(antes|depois|durante|entre|ao almo[çc]o|at[ée] [àa]s)\b)(?![^.!?\n]{0,50}?(?<!(\w+n't|\b(dont|wont|cant|not|nor|or|nem|n[ãa]o|never))\s((by|via|on|in|por|pelo|pela|no|na)\s)?)\b((call|ring|phone|text|whatsapp) (me|us)\b|whatsapp\b|lig(ue|uem|a)-(me|nos)\b|liguem? para\b|prefiro (falar )?(ao|por) telefone))|n[ãa]o (me |nos )?(envie|enviem) mais(?!\s+(?!(e-?mails?|mails?|mensage\w*|correios?|nada(?! em)|coisas?|publicidade|spam|newsletters?|informa\w*|propostas?(?! gen)|campanhas?|isto|isso|disto|disso|contactos?)\b)[\wÀ-ɏ]+( [\wÀ-ɏ]+){0,3}\s*[,;.]\s*[^\n]{0,60}?(\b(mande|envie|mandem|enviem)(-me|-nos)?\s+(o|a|os|as|um|uma|s[óo]|apenas|antes)(?![\wÀ-ɏ])|\bescrev\w* em portugu|\bquanto (custa|fica|cobra)))|(?<!\b(nunca|n[ãa]o)\s)(?<!\b(clientes|pessoas|eles|elas|customers)\s)parem? de (me |nos )?(enviar|mandar)|para de (me|nos) (enviar|mandar)|retir\w* (o )?(meu|nosso) (e-?mail|contacto|endere[çc]o)(?!\s+(pessoal|pessoais|antigo|velho|privado|particular)\b)(?![^.!?]{0,30}\b(do|no|da|na) (site|rodap[ée]|p[áa]gina|google|facebook|instagram|footer|cabe[çc]alho|cart[ãa]o)\b)|retir\w* (este|esse|o) (e-?mail|contacto|endere[çc]o) d[ae] (vossa |sua )?(lista|base de dados|mailing)|dezabon\w*|nu sunt interesat\w*|ne zanima|nav interes\w*)(?![\wÀ-ɏ])|(?<![\w-])(?<!\b(caf[ée]|bar|snack|auto|oficina|restaurante|pastelaria|minimercado|centro comercial)\s)(?<!\b(bus|tram|metro|train|tube|subway|full|pit|truck|next|last|first|don'?t|do not|never|n[ãa]o)\s)stop\b(?!-)(?!\s+(spam(ming)?\s+)?(bots?|robots?)\b)(?!\s+(caf[ée]|bar|shop|lda|unipessoal|restaurante|pizzaria|snack)(?![\wÀ-ɏ]))(?!\s+(the|those|these|our|my|any)\s+(?!((automated|automatic|cold|further|endless|annoying|unsolicited|unwanted|constant|repeated|daily|weekly|promotional|spammy|junk|mass|bulk)\s+)*(madness|outreach|e-?mails?|e-?mailing|mails?|mailings?|messages?|follow[- ]?ups?|newsletters?|contacts?|contacting|communications?|correspondence|marketing|nonsense|harassment|sales|pitch\w*|spam(?!\s+(bots?|filters?|on|in|from|through|via)\b))\b)[a-z])(?!\s+(that|it|this)\b(?![^]{0,200}?(\b(pay|paid|pagou|pagaram|pagam|pago)\b|\bem paz\b|\balone\b))[^]{0,200}?(how much|price|quote|cost|pre[çc]o|quanto)[^.!\n]{0,60}\?)(?!\s+(by|in|over|thinking|showing(?! up in (my|our) (inbox|mailbox|e-?mail))|loading|working|bots?|the bots)\b)(?!\s+((?!(showing up in (my|our) (inbox|mailbox|e-?mail)|(filling|flooding|clogging|cluttering|stuffing)( up)? (my|our|the) (inbox|mailbox)|bombarding|pinging|hounding|pushing (your|these|this) (services?|offers?|products?|stuff|e-?mails?)|e-?mailing|mailing|sending|contacting|messaging|writing|spamming|bothering|pestering|harass\w*|texting|calling(?!\s+(at|after|before|to|for|in the)\b)|ringing|following|reaching|receiving(?!\s+(bookings?|reservations?|calls?|orders?)\b)|wasting(?!\s+(hours|so much time|time on)\b)|trying|selling|pitching|bugging|annoying|asking|adding|targeting|chasing|marketing|soliciting|cold|during|nothing|anything|something|everything|morning|evening|bring|thing)\b)[a-z]{2,}ing\b|spam (on|in|from|through|via) (the |our |my )?(contact |booking )?(form|site|website|inbox)))|^[\s"'«]*(stop|parar|remover|sair|remove|unsubscribe)[\s.!"'»]*$|не се интересувам|δεν ενδιαφέρομαι|^[\s"'«]*(n[ãa]o,?\s*obrigad[oa]|no,?\s*thanks?( you)?|no thank you|dispens\w+|no need,?\s*thanks?( you)?|not for us,?( thanks?( you)?)?|de momento n[ãa]o,?\s*obrigad[oa]|n[ãa]o quero|j[áa] (lhe |vos )?disse que n[ãa]o[^?]*|n[ãa]o,?\s*obrigad[oa][.!,]?\s*j[áa] temos (site|um site|quem (o |nos )?fa[çc]a)[^.!]*|no,?\s*thanks?,?\s*we (already )?have (a |an |our )?(web ?(agency|designer|developer)|website|site|developer)[^.!]*|n[ãa]o precisamos|n[ãa]o queremos|n[ãa]o pretend\w*|agradecemos o contacto,? mas (de momento |neste momento )?n[ãa]o precisamos|agrade[çc]o,?\s*mas n[ãa]o|j[áa] temos (quem (o |nos )?fa[çc]a isso|site|um site|fornecedor))[\s.!,"'»]*(obrigad[oa]|thanks?|thank you)?[\s.!"'»]*$|\b((eras\w*|delete) (my|our) (personal )?(data|details|e-?mail( address)?|address|information|info|contact( details)?)(?=\s+from (your|the|this) (list|records|database|system|files|mailing|contacts)|\s*([.,!;]|$|please\b))|i (object|am objecting) to (the |your )?(processing\b|use of (my|our)\b)|(apag|elimin|exclu)(?!(ou|iu|aram|iram|ava|avam|ado|ada|ados|adas|ido|ida)\b)\w*( o| a)? (meu|nosso|minha|nossa) (e-?mail|contacto|contato|endere[çc]o)(?=\s*([.,!;]|$|por favor\b|obrigad)|\s+d[aeo]s? (vossa |sua |tua |vosso |seu )?(lista|mailing|base|cadastro|registos|sistema|contactos))|(exer[çc]o|exercemos|exijo|exigimos|invoco|invocamos|solicito|solicitamos|requeiro|requeremos|(quero|queremos|pretendo|pretendemos|venho|vimos)( por este meio)? (exercer|invocar|solicitar|requerer))( o| os)?( (meu|nosso|meus|nossos))? direitos? (de|à|a|ao) (oposi[çc][ãa]o|apagamento|elimina[çc][ãa]o|esquecimento)|oponho-me|opomo-nos|(apagamento|elimina[çc][ãa]o|supress[ãa]o|remo[çc][ãa]o) d[oa]s? (meus|nossos) (dados|contactos?|e-?mails?)( pessoais)?(?=\s*([.,!;]|$|por favor\b|obrigad)|\s+d[ao]s? (vossa|sua|vosso|seu|vossas|vossos) )|n[ãa]o autorizo (o |a )?(uso|tratamento|utiliza[çc][ãa]o) d[oa]s? (meus|nossos|meu|nosso) (dados|e-?mail|contacto|endere[çc]o)|(^|[.!?]\s*)(blocked|bloquead[oa]s?)[\s.!]*$|\b(i|we)('ve| have)? (just |now )?(blocked|am blocking|are blocking) (you|your (e-?mails?|address|domain))\b|\b(vou|vamos|irei) bloquear (o seu|o vosso|os vossos|os seus|este|esse|o teu) (e-?mail|e-?mails|endere[çc]o|contacto|dom[íi]nio)|(para|como) (deixar de|parar de|n[ãa]o (voltar a )?)\s?receber (mais )?((os |as )?(e-?mails|mensagens) (seus|vossos|teus|de voc[êe]s)|(estes|esses) (e-?mails|mensagens)(?! d[eo]))[^.\n]{0,60}\?|how (do|can) i (stop (receiving|getting) (these|your|this)( e-?mails| messages)?\s*\?|stop (receiving|getting) your (e-?mails|messages)|get off (your|this) (mailing )?list)|\b(do not|don'?t) write to (me|us)( again| anymore| any more)?(?=\s*([.!,;]|$|please|thanks?))(?![.,;!]?\s*(just |instead,? |please |rather )?(come|pop|swing|visit|call|ring|phone|text|whatsapp)\b)|\bn[ãa]o (me |nos )(escreva|escrevam)(?=\s*([.!,;]|$|por favor|obrigad))|\bleave (me|us) alone\b|\bdeix\w*[- ](me|nos) em paz\b|(?<!\b(spammers?|bots?|rob[ôo]s|vendedores|chamadas|telefonemas|clientes)\s(n[ãa]o\s)?)\b(me|nos) deix\w* em paz\b|^[\s"'«]*(por favor,?\s*|please,?\s*)?(parem|pare)(,?\s*(por favor|please|j[áa]))?[\s.!"'»]*$)|\b(purge|wipe|erase) (us|me|(our|my) (details|data|records|information|info|contact\w*|e-?mail( address)?))\b(?![^.!?\n]{0,40}\b(old|previous|antig\w*|site|website|server|host\w*|backup)\b)|\b(i|we) (want|wish|would like|ask|demand) to be forgotten\b|\b(quero|queremos|gostaria de|gostar[íi]amos de) (parar|deixar) de receber\s*[.!]*\s*$|\b(pe[çc]o|pedimos|solicito|solicitamos|exijo|exigimos) (a |o )?(elimina[çc][ãa]o|apagamento|exclus[ãa]o)( imediat[ao])?(?=\s*[.!]|\s*$|,? d[oa]s? (meus|nossos|minhas|nossas) (dados|contactos?|e-?mails?|endere[çc]os?|informa))|^\W*exclus[ãa]o,? (por favor|pf|p\.f\.)\W*$|\b(remov|retir|apag|elimin|exclu)\w*\s+(o |a |the )?[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+\s+(d[aeo]s?\s+(vossa |vossas |sua |suas |vosso |seu )?(lista|listas|base|mailing|contactos|contatos|cadastro)|from (your|the|all) (list|lists|mailing|database|contacts|records))/i;   // a bare polite no; erasure / objection requests (GDPR Art. 17 / 21) are opt-outs too
const COMPLAINT_RX = /((?<!\b(thought|assumed|guessed|believed|figured|wonder\w*|if|whether|maybe|perhaps|says?|said|tells?|told|hope|hoped|feared|afraid|worried|not sure|pensei|pensava|achei|achava|julguei|julgava|parecia|se|talvez|diz|disse|dizem|disseram|duvido|espero|receio)\b[^.!?]{0,30})(?<![\wÀ-ɏ])(?!(?<=\b(inbox|caixa( de correio)?|nosso e-?mail|our e-?mail|bots?|robots?|rob[ôo]s|contact page|p[áa]gina( de contactos?)?|formul[áa]rio|form|reviews|avalia[çc][õo]es|coment[áa]rios|comments|booking|reservas|junk|lixo|filter|filtro)\b[^]{0,80})(?<!\b(you|your|voc[êe]s?|vos|vosso|vossa)\b[^]{0,80})(?![^.!?]{0,60}\b(you|your|voc[êe]s?|vos|vosso|vossa)\b(?!\s+(resolvem|conseguem|podem|fazem|can|could)\b))(?=[^.!?]{0,40}?\bspam\s+(all|every|non-?stop|daily|tod[oa]s?|o dia|sem parar|constante|de (bots?|rob[ôo]s)|from (bots?|robots?))\b))(this|that|it)( is|'s)( (just|pure|total|clearly|obviously))? spam\b(?!\s*\?)(?![^.!?]{0,60}\b(but|mas|por[ée]m|or not)\b)|(?<!\b(formul[áa]rio|form|coment[áa]rios)\b[^.!?]{0,30})(?<!\b(thought|assumed|guessed|believed|figured|wonder\w*|if|whether|maybe|perhaps|says?|said|tells?|told|hope|hoped|feared|afraid|worried|not sure|pensei|pensava|achei|achava|julguei|julgava|parecia|se|talvez|diz|disse|dizem|disseram|duvido|espero|receio)\b[^.!?]{0,30})(?!(?<=\b(inbox|caixa( de correio)?|nosso e-?mail|our e-?mail|bots?|robots?|rob[ôo]s|contact page|p[áa]gina( de contactos?)?|formul[áa]rio|form|reviews|avalia[çc][õo]es|coment[áa]rios|comments|booking|reservas|junk|lixo|filter|filtro)\b[^]{0,80})(?<!\b(you|your|voc[êe]s?|vos|vosso|vossa)\b[^]{0,80})(?![^.!?]{0,60}\b(you|your|voc[êe]s?|vos|vosso|vossa)\b(?!\s+(resolvem|conseguem|podem|fazem|can|could)\b))(?=[^.!?]{0,40}?\bspam\s+(all|every|non-?stop|daily|tod[oa]s?|o dia|sem parar|constante|de (bots?|rob[ôo]s)|from (bots?|robots?))\b))(isto|isso|este e-?mail|esta mensagem|isto aqui|isso aqui|esse e-?mail|essa mensagem) (é|e) (puro |mesmo |s[óo] )?spam(?!\s*\?|\s+ou\b)(?![^.!?]{0,60}\b(but|mas|por[ée]m)\b)|^[\s\W]*((é|e|isto é|isso é|this is|it'?s|just|more|mais|outra vez|again)\s+)?spam[^\w?]*(again|outra vez|de novo)?[^\w?]*$|(?<!\b(thought|assumed|pensei|achei|julguei)\b[^.!?]{0,30})(?<!\b(form|formul[áa]rio|site|inbox|captcha|bots?|block|bloquear)\b[^.!?]{0,30})spammer\w*(?![^.!?]{0,60}\b(form\w*|formul[áa]rio|site|captcha)\b)(?!(?![^.!?]{0,60}\b(you|voc[êe]s?|vos|te|vosso|vossa|teu|tua)\b)[^.!?]{0,60}\b(page|p[áa]gina|reviews?|avalia\w*|comments?|coment[áa]rios?|booking|reservas|marca[çc][õo]es|instagram|facebook|google|whatsapp|caixa de correio|enchem-nos|lotam)\b)|(?<!\b(bots?|robots?|people|someone|spammers)\s)spamming(?!\s+(the|our|my|o|os|nosso|nossa|nossos|nossas)\s+(contact |booking |google |facebook |instagram )?(form|formul|site|inbox|reviews?|avalia|coment|comments?|page|p[áa]gina|instagram|facebook|whatsapp|booking|reservas))(?!\s+(bots?|robots?)\b)|stop spamming(?!\s+(bots?|robots?)\b)|(?<!\b(n[ãa]o|nunca|bots?|robots?|rob[ôo]s|spammers|eles|elas)\s)\b(para(r|m)? de (fazer |mandar |enviar )?spam|parem? de (fazer |mandar |enviar )?spam|parem com (o|este|esse) spam|chega de spam)\b(?![^.!?]{0,60}\b(form\w*|formul[áa]rio|site|captcha|filtros?|filters?|reservas|marca[çc][õo]es|avalia[çc][õo]es|coment[áa]rios|p[áa]gina|instagram|facebook)\b)(?![^.!?\n]{0,80}\?)(?![^]{0,300}\b(?:form\w*|formul[áa]rio|captcha|filtros?|filters?|bots?|robots?|rob[ôo]s?|quanto (?:custa|fica|cobra)|or[çc]amentos?|pre[çc]os?)(?![\wÀ-ɏ]))(?<!(?<![\wÀ-ɏ])(?:form\w*|formul[áa]rio|captcha|filtros?|filters?|bots?|robots?|rob[ôo]s?|quanto (?:custa|fica|cobra)|or[çc]amentos?|pre[çc]os?)(?![\wÀ-ɏ])[^]{0,330})|(?<!\b(almost|nearly|about to|was going to|quase)\s+)(?<!\b(a|an|the|any|some|sample|example|that|this|your|my|our)\s)report(ed|ing)? you\b(?!\s+(back|did|do|does|were|are|had|have|as (the |a |an )?(best|good|great|top|reliable|right))\b)(?!\s+to (my|our) (business )?(partner|boss|wife|husband|team|colleagues?|manager)\b)|(?<!\b(pin|listing|maps?|hack\w*|break-?in|burglary|theft|stolen|vandal\w*|outage)\b[^]{0,80})(?![^.!?]{0,60}\b(twice|several times|many times|nothing changed|still shows|that (our|the|my) ([\wÀ-ɏ]+ )?(hours|address|pin|listing|location|map))\b)(?<!\b(almost|nearly|about to|was going to)\s+)report(ed|ing)? (this |it |you )?to (google|gmail|microsoft|outlook|the (ico|cnil|cnpd|regulator|authorities|police))\b|(this|that|it|isto|isso)( is|'s| é)( a| an| uma)?( clear| blatant| obvious)? (gdpr|rgpd) (violation|breach|infringement)(?![^.!?]{0,60}\b((on|in|of|with) (our|my) (own |current |old )?(site|website|page|shop)|(i|we) (want|need) to fix|can you (fix|help|add))\b)|(?<!\b(pensei|achei|julguei|parecia|parece|pensava|achava|era|seria|fosse|thought)\b[^.!?]{0,30})\bmais um spam\b(?!\s*\?)(?![^.!?]{0,60}\b(form\w*|formul[áa]rio|captcha|caixa de correio|inbox|reservas|coment[áa]rios|avalia[çc][õo]es|p[áa]gina|filtro)\b)(?![^.!?]{0,60}\b(mas|but|por[ée]m|contudo)\b)|(?<!\b(almost|nearly|quase|about to|ia|gmail|outlook|google|yahoo|filter|filters|was|were|got|been|be|is|are|being|had|automatically|gets|get|getting|keeps|not|never|aren'?t|isn'?t|won'?t|don'?t|doesn'?t) )(?<!\b(accidentally|mistakenly|wrongly|assistant|secretary|receptionist|colleague|antivirus|secret[áa]ria|rece(p)?cionista|colega|filtro)\b[^.!?]{0,20})(?![^.!?]{0,60}\b(by (mistake|accident)|accidentally|mistakenly|sem querer|por (engano|erro))\b)(report(ed|ing)? (this |it |you )?(as|for) spam|mark(ed|ing)? (this |it |you |your e-?mails? |this e-?mail )?as spam|flag(ged|ging)? (this |it |you |your e-?mails? |this e-?mail )?as spam|marquei( isto| isso| este e-?mail| o (seu|vosso|teu) e-?mail| os (seus|vossos) e-?mails|-o|-vos|-te)? como spam|(vou|vamos|irei) marcar( isto| isso| este e-?mail| o (seu|vosso|teu) e-?mail| os (seus|vossos) e-?mails|-vos|-te)? como spam)|(?<!(veio|vinha|chegou|ficou|estava|apareceu|caiu|foi|vem|vêm|está|estão|esta|estavam|aparece|aparecem|chega|chegam|chegaram|fica|ficam|ficaram|vieram|tinha|seja|sido|ser|for|fosse|n[ãa]o) )(?<!\b(tinha|tinham|havia|haviam)-(o|a|os|as) )marcad[oa] como spam(?!\s+(pel[oa]|por|no|na)\b)(?![^.!?]{0,40}\b(sem querer|por (engano|erro))\b)|(?<!\b(quase|ia|almost)\s+((que|te|vos|o|a|os|as|lhe)\s+){0,2})(?<!\b(fals[oa]s?|fake|instagram|facebook|google|perfil|p[áa]gina)\b[^.!?]{0,60})denunciei(?!\s+(o|a|os|as)\s+(outr[oa]s?|[úu]ltim[oa]s?|antig[oa]s?|anterior(es)?|tipo|rapaz|(web )?designer|inform[áa]tico|programador|ag[êe]ncia|empresa (de|que|do|da|anterior))\b)(?!\s+(um|uma)\b)(?!\s+(à|ao|aos|às)\s+(?!cnpd|autoridade|pol[íi]cia|google|gmail))|reportei(?![^.!?]{0,40}\b(hor[áa]rio|morada|endere[çc]o|localiza\w*|pin|errad[oa]s?|avaria|buraco)\b)(?!\s+(o|a|os|as)\s+(outr[oa]s?|[úu]ltim[oa]s?|antig[oa]s?|anterior(es)?|tipo|rapaz|(web )?designer|inform[áa]tico|programador|ag[êe]ncia|empresa (de|que|do|da|anterior))\b)(?!\s+(o|a|os|as)\s+(erro|problema|falha|bug|p[áa]gina|perfil|hor[áa]rio|morada)\w*\b)(?!(\s+[^\s.!?,;]+){0,4}?\s+(à|ao|aos|às|com|para)\s+(?!cnpd|autoridade|pol[íi]cia|google|gmail|tribunal))|(?<!\b(workplace|sexual|anti|casos de|cases of|problema de|problemas de|caso de)[\s-])(?<!(?<!\b(your|vossos|vossas|seus|suas|teus)\s)\b(customers|clients|sellers|salespeople|salesmen|vendors|callers|spammers|competitors|employee|clientes|vendedores|funcion[áa]rio)\b[^.!?]{0,30})(harass\w*(?!\w)(?!\s+(issue|problem|case)\b)|ass[ée]dio)(?!\s+(laboral|no trabalho|no local de trabalho|cases?|claims?|law|lawyers?|prevention)\b)|(?<!\b(got|get|gets|received|receive|had|have|avoid)\s(a |an |any )?)(?<!\b(customer|client|patient|user|visitor|someone)\b[^.!?]{0,25})gdpr complaint(?!\s+(against|about) (our|my|the) (old |previous |former |current )?(site|website|shop|company|business|clinic)\b)|(?<!\b(customer|client|patient|user|visitor|someone)\b[^.!?]{0,25})complaint to the (ico|cnil|cnpd|regulator)(?![^.!?]{0,40}\babout (our|my|the) (old |previous |former |current )?(site|website|shop|company|business|clinic|cookie\w*|privacy)\b)|(?<!\b(pin|listing|maps?|hack\w*|break-?in|burglary|theft|stolen|vandal\w*|outage)\b[^]{0,80})report(ed|ing)? (this|it|you) to the (ico|cnil|cnpd|regulator|authorities)|(?<!\b(um|uma|o|a|algum|alguns|nosso|nossa) (cliente|utente|paciente|vizinho|visitante|utilizador)\b[^.!?]{0,20})queixa (à|a|na) cnpd|(?<!\b(um|uma|o|a|algum|alguns|nosso|nossa) (cliente|utente|paciente|vizinho|visitante|utilizador)\b[^.!?]{0,20})(reclama[çc][ãa]o|queixa|den[úu]ncia) (à|a|na|junto da|para a) cnpd|(vou|vamos|irei|iremos|vou ter de|vamos ter de|tenciono|pretendo|tencionamos|pretendemos) (fazer|apresentar) (uma )?queixa(?![^.!?]{0,30}\b(à|na|ao|junto d[ao]|da|do|contra a|contra o) (c[âa]mara|junta|condom[íi]nio|senhorio|operadora|meo|vodafone|ctt|edp|seguradora|banco|google|asae|wix)\b|[^.!?]{0,50}\b(estacionamento|buraco|internet|ru[íi]do|obras)\b)(?!(?![^.!?]{0,30}\b(como|like|as) (fiz|fizemos|fizeram|I did|we did)\b)[^.!?]{0,45}\b(antig[oa]s?|anterior(es)?|programador|concorrente|fornecedor)\b)|(?<!\b(google|instagram|facebook|perfil|antig[oa]s?|ag[êe]ncia)\b[^.!?]{0,60})(fiz|fizemos|apresentei|apresent[áa]mos)( j[áa])? (uma )?queixa(?![^.!?]{0,30}\b(à|na|ao|junto d[ao]|da|do|contra a|contra o) (c[âa]mara|junta|condom[íi]nio|senhorio|operadora|meo|vodafone|ctt|edp|seguradora|banco|google|asae|wix)\b|[^.!?]{0,50}\b(estacionamento|buraco|internet|ru[íi]do|obras)\b)(?!(?![^.!?]{0,30}\b(como|like|as) (fiz|fizemos|fizeram|I did|we did)\b)[^.!?]{0,45}\b((?<!\b(vosso|vossa|seu|sua|teu|tua)\s)(outr[oa]s?|[úu]ltim[oa]s?)\b(?!\s+(e-?mails?|mensage\w*|contactos?|vez)\b)|(web )?designer|inform[áa]tico|que nos fez|de antes|empresa (de|do|da|anterior)|antig[oa]s?|anterior(es)?|programador|concorrente|fornecedor|google|ag[êe]ncia|empresa que|livro de reclama[çc][õo]es|deles|delas)\b)|vou (te |vos |lhe |os |as )?(denunci\w*|fazer queixa|apresentar queixa)(?![^.!?]{0,30}\b(à|na|ao|junto d[ao]|da|do|contra a|contra o) (c[âa]mara|junta|condom[íi]nio|senhorio|operadora|meo|vodafone|ctt|edp|seguradora|banco|google|asae|wix)\b|[^.!?]{0,50}\b(estacionamento|buraco|internet|ru[íi]do|obras)\b)(?![^.!?]{0,45}\b(antig[oa]s?|anterior(es)?|programador|concorrente|fornecedor)\b)|vou (reportar|processar)(-vos|-te|-lo|-la)\b(?!\s+(à|ao|aos|às|com)\s+(?!cnpd|autoridade|pol[íi]cia|google|gmail|tribunal))|vou (reportar|processar)( (vos|voc[êe]s?|a vossa empresa|o vosso|a sua empresa|esta empresa|isto|este|esta|o seu e-?mail))?(?=[\s.!]*$|(\s+[^\s.!?]+){0,3}\s+((à|ao|aos|às|junto d[ao]|para a)\s+(cnpd|autoridade|pol[íi]cia|google|gmail|tribunal)|como spam))|vou processar (a vossa|a sua|esta) empresa|denunciar (este|esta|o seu|vos|-vos)\b(?!\s+(tipo|g[ée]nero)\b)|(?<!\b(send|sent|sending|enviar|envi[áa]mos|received|receive|got|get|had|recebemos|recebi)\s(an? |um )?)cease and desist|(?<!\b((had|have) to (take|start|send)|(we|they) took|took|threatened|threatening|threatens)\s)(?<!\b(landlord|neighbou?r|tenant|supplier|competitor|customer|client|employee)\b[^.!?]{0,30})legal action(?!\s+with\s+(our|the|my) (old|previous|former|last|ex)\b)(?!\s+against\s+(him|her|them|it|the|a|our|my)\b)|(?<!\b(tivemos|tiveram|houve|teve|ganh\w+|perdemos|perdeu)\s(uma )?)a[çc][ãa]o judicial(?![^.!?]{0,45}\b(antig[oa]s?|anterior(es)?|programador|concorrente|fornecedor|ag[êe]ncia|empresa que)\b)|(?<!\b(site|website|webpage|p[áa]gina|form|formul[áa]rio|plugin|cookies?|banner|seria|would be)\b[^.!?]{0,25})(?<!\b(evitar|evite|avoid\w*|prevent\w*|prevenir)\s)(?<!\b(estamos a|estaremos a|estamos em|we'?re|we are|we might be|we may be|we could be|we'?d be|are we|(we'?re|we are|we might be|we may be|are we) in|a gente est[áa])\s)(viola[\wçõã]*|ilegal|illegal|violat\w*|breach\w*)( d?[oa]| of| the)* (rgpd|gdpr)|abmahnung|abmahnen|unterlassungserkl\w*|(my|our) (lawyers?|attorneys?|solicitors?) (will|is going to|are going to) (be in touch|contact|reach out|hear|sue|take (legal )?action)(?!(?![^.!?]{0,100}\b(unsolicited|consent\w*|consentimento|spam\w*|gdpr|rgpd|permiss\w*|autoriza\w*|harass\w*|n[ãa]o solicitad\w*|(these|your|estes|os vossos|os seus) e-?mails)\b)[^.!?]{0,60}\b(contracts?|contratos?|propostas?|proposals?|sign|assinar|assinamos|start|come[çc]ar)\b)|(o meu|o nosso) advogado (vai|ir[áa]) (vos |lhe |te )?(contactar|processar|entrar em contacto)(?!(?![^.!?]{0,100}\b(unsolicited|consent\w*|consentimento|spam\w*|gdpr|rgpd|permiss\w*|autoriza\w*|harass\w*|n[ãa]o solicitad\w*|(these|your|estes|os vossos|os seus) e-?mails)\b)[^.!?]{0,60}\b(contracts?|contratos?|propostas?|proposals?|sign|assinar|assinamos|start|come[çc]ar)\b)|(questo|esto|das) (è|es|ist) spam|c'est du spam|(?<!\b(de|of|getting|get|gets|got|recebe\w*|receiv\w*)\s)spam (outra vez|de novo|again)(?![^.!?]{0,40}\b(form|formul[áa]rio|site|captcha)\b)|(?<!\b(site|website|webpage|page|p[áa]gina|privacy|privacidade|policy|pol[íi]tica|form|formul[áa]rio|plugin|cookies?|banner|seria|would be|not having)\b[^.!?]{0,25})(ilegal|illegal|unlawful) (pelo|segundo o|ao abrigo do|nos termos do|à luz do|perante o|face ao|de acordo com o|under( the)?|according to( the)?) (rgpd|gdpr)(?!\s*\?)|\b(i|we)('ll| will|'m going to| am going to|'re going to| are going to| shall)( be)? (fil|lodg|mak|submit|send|rais)\w* (a |an )?(formal |official )?(gdpr )?complaint (with|to) (the )?(ico|cnil|cnpd|regulator|data protection|supervisory)\w*(?![^.!?]{0,60}\b(about|against|regarding)\b(?! (you|this|your)\b))|\b(i|we)( have|'ve)?( just| already)? complained to (the )?(ico|cnil|cnpd|regulator|data protection|authorities)\w*(?![^.!?]{0,60}\b(about|against|regarding)\b(?! (you|this|your)\b))|\b(i|we)( have|'ve)?( just| already)? (filed|lodged|made|submitted|sent|raised) (a |an )?(formal |official )?(gdpr )?complaint (with|to) (the )?(ico|cnil|cnpd|regulator|data protection|supervisory)\w*(?![^.!?]{0,60}\b(about|against|regarding)\b(?! (you|this|your)\b))|\b(you('ll| will)) hear from (my|our) (lawyers?|attorneys?|solicitors?)(?!(?![^.!?]{0,100}\b(unsolicited|consent\w*|consentimento|spam\w*|gdpr|rgpd|permiss\w*|autoriza\w*|harass\w*|n[ãa]o solicitad\w*|(these|your|estes|os vossos|os seus) e-?mails)\b)[^.!?]{0,60}\b(contracts?|contratos?|propostas?|proposals?|sign|assinar|assinamos|start|come[çc]ar)\b)|\b(one more|another|next|any more|any further) (e-?mail|message)(?![^.!?]{0,40}\b(cc|copy|include|add)\b)[^.!?]{0,40}\b(lawyers?|attorneys?|solicitors?|legal action)\b|\b(mais um|outro|pr[óo]ximo) (e-?mail|contacto|mensagem)\b(?![^.!?]{0,40}\b(c[óo]pia|cc|inclua|incluam|ponha|ponham)\b)[^.!?]{0,40}\b(advogad[oa]s?|tribunal|cnpd)\b|(vou|vamos|irei|iremos) (queixar-(me|nos)|reclamar) (à|a|na|junto da|para a) cnpd(?![^.!?]{0,45}\b(antig[oa]s?|anterior(es)?|programador|concorrente|fornecedor)\b)|(vou|vamos|irei|iremos) (fazer|apresentar) (uma )?reclama[çc][ãa]o( formal)? (à|a|na|junto da|para a|perante a) cnpd|\b(your|this|that|o seu|o vosso|este|esta|esse|essa) (e-?mail|message|mensagem|contacto|pitch|outreach)\b[^.!?]{0,40}\b(viola\w*|violat\w*|breach\w*)( d?[oa]| of| the)* (gdpr|rgpd)(?![^?]{0,30}\?)|\b(sending|enviar|mandar)( me)? (this|these|isto|e-?mails?)\b[^.!?]{0,40}\b(is|é) (a |an |uma )?(clear |blatant |obvious |clara )?(violation|breach|infringement|viola[çc][ãa]o) (of|d[oa]) (the )?(gdpr|rgpd)(?!\s*\?))|\b(report(ing|ed)?|fil(e|ing)|lodg(e|ing))\b(?![^.!?\n]{0,60}\?)[^.!?\n]{0,50}\b(to|with)\s+(the\s+)?(ftc|federal trade commission|(state )?attorneys? general|state bar|bar association|fcc)\b|\b(violat\w+|in violation of|breach\w* of)\s+(the\s+)?can[- ]?spam\b|\bcan[- ]?spam\s+violation/i;
// US regulators and CAN-SPAM (25 Oct 2026, BrandB lane to attorneys): "file a complaint with the FTC", "report this to the State Bar",
// "this violates CAN-SPAM" are complaints; asking how we handle CAN-SPAM, or whether the State Bar has looked at it, is not.
// access / source questions (GDPR Art. 15 / 14): not an opt-out, but the operator owes an answer within one month, so the alert says so
const DSR_RX = /(where|how) did you (get|find|obtain) (my|our|this) (e-?mail|address|contact|details)|what (personal )?(data|information) do you (hold|have|keep)|subject access|\bdsar\b|(onde|como) (é que )?(obteve|obtiveram|arranjou|arranjaram|conseguiu|conseguiram|encontrou|encontraram) (o )?(meu|nosso|este) (e-?mail|contacto|contato|endere[çc]o)|que dados (pessoais )?(tem|t[êe]m|possui|possuem|guarda\w*)|(direito|pedido) de acesso|acesso aos (meus|nossos) dados|art(igo|\.|icle)?\s*1[57]\b(\.?\s*[ºo°])?[^.]{0,20}(rgpd|gdpr)|\b(rgpd|gdpr)[^.]{0,20}\bart(igo|\.|icle)?\s*1[57]\b|\bcomo titular dos (meus |nossos )?dados\b|\b(apag|elimin|exclu|delet|eras|wip|purg)[\wÀ-ɏ]*( (de )?(todos os|all( of)?|any|os|the|todas as|d[oa]s|of))? (meus|nossos|my|our|dados|data|personal data|details|informa\w*)\b|\b(meus|nossos|my|our) (dados|data|personal data|details|personal details|records?)( pessoais)?( que [^.!?\n]{0,20})?\s+(apagad|eliminad|exclu[íi]d|deleted|erased|wiped|purged)|\b(apag|elimin|exclu)[\wÀ-ɏ]*-(me|nos)\b|\b(delet|eras|wip|purg)\w* (me|us) from\b|\bright to (be forgotten|erasure)\b(?<!\b(have|has|tem|t[êe]m) the right to (be forgotten|erasure))|\berasure (request|of (my|our))\b|\brequest\w* (the )?erasure|\b(meu|nosso) direito (ao|de) (apagamento|esquecimento|elimina[çc][ãa]o)|\b(exer[çc]o|exercer|exercemos|invoco|solicito|requeiro|pe[çc]o|pedimos|solicitamos)\b[^.!?\n]{0,40}\b(apagamento|esquecimento|elimina[çc][ãa]o|exclus[ãa]o)\b/i;
const dsrTag = s => DSR_RX.test(s) ? 'DATA REQUEST (GDPR: answer within one month): ' : '';   // also on stop / complaint / already-opted-out / unmatched / warm alerts
const isHoliday = (cc, day) => XMAS_ONLY ? day.slice(5) === '12-25' : holidays(cc, +day.slice(0, 4)).has(day);
let XMAS_ONLY = false;   // r35 (the operator 11 Nov 2026: "take off this hard code holiday shit unless it's Christmas Day"): kv holiday_mode=christmas_only makes 25 Dec the only non-sending holiday, for every country. Weekends still never send.
// Cold B2B email law per recipient country (researched 2026-10-21, see rulebook). REFERENCE ONLY: nothing is refused by country
// (the operator, 21 Oct 2026: every European country is open). Enrol only needs a country and a resolvable time zone.
//  named:     opt-out regime for a named work address (needs source_url outside the US)
//  company:   only to companies (Ltd/LLP/PLC/AB...), never sole traders: entity:'company' + entity_ref (registry number) + source_url
//  published: the address must be publicly published for business contact: source_url (CASL conspicuous publication, Slovakia)
//  generic:   only role addresses (info@, office@...), never a person's own address
const LAW_NOTE = { US: 'named', IE: 'named', FR: 'named', FI: 'named', GB: 'company', SE: 'company', CA: 'published', SK: 'published', BE: 'generic', NO: 'generic', SI: 'generic', EE: 'generic', HU: 'generic' };
const LAW_NO = { DE: 'UWG 7(2) consent', NL: 'Telecommunicatiewet 11.7 consent', ES: 'LSSI 21 consent', IT: 'Privacy Code 130 consent', AT: 'TKG 174 consent', CZ: 'Act 480/2004 s.7 consent', PL: 'PKE 398 consent', RO: 'Law 506/2004 consent', GR: 'Law 3471/2006 consent', DK: 'Marketing Practices Act 10 consent', LT: 'consent (natural and legal persons)', PT: 'generic only after DGC opt-out list check (not automated)', LU: 'unclear, held', BG: 'unclear, held', HR: 'unclear, held', LV: 'unclear, held', CH: 'untested, held' };
const COUNTRY_TZ = { DE: 'Europe/Berlin', NL: 'Europe/Amsterdam', ES: 'Europe/Madrid', IT: 'Europe/Rome', AT: 'Europe/Vienna', CH: 'Europe/Zurich', CZ: 'Europe/Prague', PL: 'Europe/Warsaw', DK: 'Europe/Copenhagen', PT: 'Europe/Lisbon', LU: 'Europe/Luxembourg', LT: 'Europe/Vilnius', LV: 'Europe/Riga', HR: 'Europe/Zagreb', RO: 'Europe/Bucharest', BG: 'Europe/Sofia', GR: 'Europe/Athens', IE: 'Europe/Dublin', GB: 'Europe/London', FR: 'Europe/Paris', FI: 'Europe/Helsinki', SE: 'Europe/Stockholm', SK: 'Europe/Bratislava', BE: 'Europe/Brussels', NO: 'Europe/Oslo', SI: 'Europe/Ljubljana', EE: 'Europe/Tallinn', HU: 'Europe/Budapest' };
const CA_TZ = { ON: 'America/Toronto', QC: 'America/Toronto', NS: 'America/Halifax', NB: 'America/Moncton', PE: 'America/Halifax', NL: 'America/St_Johns', MB: 'America/Winnipeg', SK: 'America/Regina', AB: 'America/Edmonton', BC: 'America/Vancouver' };
const GDPR_CC = new Set(['IE', 'FR', 'FI', 'GB', 'SE', 'SK', 'BE', 'NO', 'SI', 'EE', 'HU', 'DE', 'NL', 'ES', 'IT', 'AT', 'CH', 'CZ', 'PL', 'DK', 'PT', 'LU', 'LT', 'LV', 'HR', 'RO', 'BG', 'GR', 'IS', 'MT', 'CY']);
const FOOTER_INTL = '\n\nAlex Operator\nBrand A Websites\n+1 555-010-0100\n\n--\n123 Example St, Los Angeles, CA 90001, USA\nNot relevant? Reply "stop" and I won\'t email again.';
const GENERIC_RX = /^(info|contact|kontakt|kontakty|office|hello|hi|mail|post|postmaster|sales|admin|enquiries|enquiry|inquiries|bonjour|hej|moi|tere|szia|iroda|toimisto|kontor|bureau|reception|team|studio|shop|booking|bookings|reservations|reservation|support)@/;
const FOOTER_GDPR = (src, co) => `\n\nAlex Operator\nBrand A Websites\n+1 555-010-0100\n\n--\n123 Example St, Los Angeles, CA 90001, USA\nI found this address at ${src}. I'm writing because it relates to your work at ${co}; legal basis: legitimate interest. Reply "stop" and I won't email again and will delete your details. Privacy notice: example.com/privacy`;
const FOOTER_CA = '\n\nAlex Operator\nBrand A Websites\n555-010-0100\n\n--\n123 Example St, Los Angeles, CA 90001, USA, example.com\nNot relevant? Reply "stop" and I won\'t email again.';
const srcName = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return String(u || '').slice(0, 60); } };
// BrandB cold lane (25 Oct 2026): US attorneys only, signed as the founder; CAN-SPAM address = Brand B, Inc.'s registered office.
const FOOTER_BRANDB = '\n\nAlex Operator\nFounder, BrandB\n\n--\nBrand B, Inc., 456 Example Ave, Los Angeles, CA 90001\nNot relevant? Reply "stop" and I won\'t email again.';
const COLD_LANES = ['branda', 'brandb'];
// Each cold lane can be held on its own (kv kill_<lane>), under the one global stop. BrandB stays held until the operator arms it: no row = held.
const laneHeld = (kv, lane) => lane === 'brandb' && !(kv.kill_brandb === 'off' || kv.kill_brandb === '0');
// r33 (the operator, 10 Nov 2026: focus on the coach / personal AI lane): batches named coach-* or trainer-* are Brand C pitch to US coaches.
// Same branda lane, inboxes, caps and law; they sign as Brand C and take the first-email slots ahead of older website prospects.
const FOOTER_TRAINER = '\n\nAlex Operator\nBrand C\n555-010-0100\n\n--\n123 Example St, Los Angeles, CA 90001\nNot relevant? Reply "stop" and I won\'t email again.';
const isCoach = p => p?.lane === 'branda' && /^(coach|trainer)/i.test(p?.batch || '');
const isBrandC = p => isCoach(p) || (p?.lane === 'branda' && /^(aps|clc)-/i.test(p?.batch || ''));   // 20 Nov 2026: autopilot Partner list (aps-) and Craigslist coach (clc-) batches sign as Brand C too; slot priority (isCoach) unchanged
function footerFor(p) {
  if (p.lane === 'brandb') return FOOTER_BRANDB;
  const cc = p.country || 'US';
  if (isBrandC(p) && cc === 'US') return FOOTER_TRAINER;
  if (GDPR_CC.has(cc)) return p.privacy_live && p.source_url ? FOOTER_GDPR(srcName(p.source_url), p.company || dom(p.email)) : FOOTER_INTL;
  if (cc === 'CA') return FOOTER_CA;
  return FOOTER;
}
// r24b: consumer mail a Portuguese small business (or a stranger) really uses but the list missed: Cabovisão/NOWO netvisao.pt, mail.pt, Brazilian ISPs,
// every national Yahoo / GMX / Proton domain. A consumer domain is never "the company": otherwise a stranger on it ties the prospect on it and no pause fires
const FREEMAIL = new (class extends Set { has(d) { return super.has(d) || /^((yahoo|ymail|rocketmail|gmx|aol|proton(mail)?)\.(com\.)?[a-z]{2,3}|(netvisao|mail|meo|vodafone|nos)\.pt|(uol|bol|terra|ig|globo)\.com\.br|libero\.it|tiscali\.it|virgilio\.it|t-online\.de|wp\.pl|o2\.pl|interia\.pl|centrum\.cz|email\.cz|tutanota\.(com|de)|tuta\.io|pm\.me)$/.test(String(d || '')); } })(['gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com',
  'proton.me', 'protonmail.com', 'gmx.com', 'mailbox.com', 'providermail.com', 'fastmail.com', 'hey.com',
  'gmx.de', 'gmx.net', 'web.de', 'orange.fr', 'wanadoo.fr', 'free.fr', 'sfr.fr', 'laposte.net', 'yahoo.fr', 'yahoo.co.uk', 'btinternet.com', 'sky.com', 'eircom.net', 'telia.com', 'online.no', 'azet.sk', 'centrum.sk', 'post.sk', 'freemail.hu', 'citromail.hu', 'siol.net', 'mail.ee', 'suomi24.fi', 'luukku.com', 'skynet.be', 'telenet.be', 'seznam.cz', 'yandex.com', 'mail.ru', 'shaw.ca', 'rogers.com', 'sympatico.ca', 'videotron.ca', 'sapo.pt', 'iol.pt', 'clix.pt', 'netcabo.pt', 'mail.telepac.pt', 'telepac.pt', 'portugalmail.pt', 'oninet.pt', 'net.novis.pt', 'aeiou.pt']);
// r24b: national Microsoft consumer domains (hotmail.pt, outlook.pt, live.com.pt, hotmail.es...) are consumer mail too, never "the company"
const MS_CONSUMER = new (class extends Set { has(d) { return super.has(d) || /^(outlook|hotmail|live|msn|windowslive|passport)\.(com\.)?[a-z]{2,3}$/.test(String(d || '')); } })(['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'hotmail.co.uk', 'outlook.co.uk', 'live.co.uk', 'passport.com']);
const THANKS = [
  "Thanks, that's helpful. I'll come back to you if we go ahead.\n\nAlex",
  "Appreciate the quick reply, thank you. I'll be in touch if it's a fit.\n\nAlex",
  "Thanks for getting back to me. That gives me what I need for now.\n\nAlex",
  "Great, thank you. I'll let you know once I've decided.\n\nAlex"];
const E = 'America/New_York', C = 'America/Chicago', M = 'America/Denver', P = 'America/Los_Angeles';
const STATE_TZ = { CT: E, DE: E, DC: E, FL: E, GA: E, IN: E, KY: E, ME: E, MD: E, MA: E, MI: E, NH: E, NJ: E, NY: E, NC: E, OH: E, PA: E, RI: E, SC: E, VT: E, VA: E, WV: E,
  AL: C, AR: C, IL: C, IA: C, KS: C, LA: C, MN: C, MS: C, MO: C, NE: C, ND: C, OK: C, SD: C, TN: C, TX: C, WI: C,
  CO: M, ID: M, MT: M, NM: M, UT: M, WY: M, AZ: 'America/Phoenix', CA: P, NV: P, OR: P, WA: P, AK: 'America/Anchorage', HI: 'Pacific/Honolulu' };

// ---------- time ----------
const pad = n => String(n).padStart(2, '0');
const FMT = new Map(), PARTS = new Map();   // Intl formatters are expensive to build: one per zone, results memoised per minute (CPU budget per tick)
function partsIn(tz, ms) {
  const k = tz + '|' + Math.floor(ms / 60000), hit = PARTS.get(k); if (hit) return hit;
  let f = FMT.get(tz); if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); FMT.set(tz, f); }
  const o = {}; for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  const r = { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute };
  if (PARTS.size > 20000) PARTS.clear(); PARTS.set(k, r); return r;
}
const dayIn = (tz, ms) => { const p = partsIn(tz, ms); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
function zonedToUtc(day, minutes, tz) {
  const [y, m, d] = day.split('-').map(Number), want = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  let g = want; for (let i = 0; i < 3; i++) { const p = partsIn(tz, g); g += want - Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi); }
  return g;
}
const dow = day => new Date(day + 'T12:00:00Z').getUTCDay();
const isSendingDay = day => dow(day) >= 1 && dow(day) <= 5 && !isHoliday('US', day);   // the system's working day (US); each recipient's own day is checked too
const recipDay = (cc, day) => dow(day) >= 1 && dow(day) <= 5 && !isHoliday(cc || 'US', day);
function addDays(day, n) { const t = new Date(day + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
function addBusinessDays(day, n) { let d = day; while (n > 0) { d = addDays(d, 1); if (isSendingDay(d)) n--; } return d; }
function addSendDays(day, n, cc) { let d = day; while (n > 0) { d = addDays(d, 1); if (isSendingDay(d) && recipDay(cc, d)) n--; } return d; }
const DAY = 86400000;

// ---------- small utils ----------
const dom = a => (a || '').split('@').pop().toLowerCase().trim();
const lc = s => (s || '').toLowerCase().trim();
const gcanon = s => { const [u, d] = lc(s).split('@'); return (d === 'gmail.com' || d === 'googlemail.com') ? u.split('+')[0].replace(/\./g, '') + '@gmail.com' : lc(s); };   // Gmail ignores dots and +tags: j.doe@ and jdoe@ are one inbox (14 Nov false stranger pause)
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const words = s => (s.match(/\S+/g) || []).length;
function b64u(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
const b64uStr = s => b64u(new TextEncoder().encode(s));
const json = (o, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { 'content-type': 'application/json' } });
function shingles(t) { const w = lc(t).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean), s = new Set(); for (let i = 0; i + 2 < w.length; i++) s.add(w.slice(i, i + 3).join(' ')); return s; }
function jaccard(a, b) { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n); }

// ---------- context ----------
class Ctx {
  constructor(env, now) { this.env = env; this.db = env.DB; this.now = now; this.t0 = Date.now(); this.W = []; this.out = []; this.alerts = []; this.fetches = 0; this.zcalls = 0; this.inSend = false; }
  q(sql, ...a) { this.W.push(this.db.prepare(sql).bind(...a)); }
  ev(kind, box, target, detail, alert = 0) {
    this.q('INSERT INTO events(at,kind,box,target,detail,alert) VALUES(?,?,?,?,?,?)', this.now, kind, box || null, target || null, String(detail || '').slice(0, 600), alert);
    this.out.push(`${kind} ${box || ''} ${target || ''} ${String(detail || '').slice(0, 120)}`.trim());
    this.S && this.S.events.push({ at: this.now, kind, box, target, detail, alert });
    if (alert) this.alerts.push(`${kind.toUpperCase()} ${box || ''} ${target || ''}\n${detail || ''}`.trim());
  }
  kv(k, v) { this.S.kv[k] = v; this.q('INSERT OR REPLACE INTO kv(k,v) VALUES(?,?)', k, String(v)); }
  async f(url, init) { if (this.fetches >= FETCH_BUDGET) throw new Budget('fetch budget'); if (Date.now() - this.t0 > 150000) throw new Budget('time budget'); this.fetches++; return fetch(url, { ...init, signal: AbortSignal.timeout(20000) }); }
}
class Budget extends Error {}
class AppBudget extends Budget {}   // one API app's OAuth limit is used up: skip that app's inboxes, the other apps carry on

async function loadState(ctx) {
  const db = ctx.db, since30 = ctx.now - 31 * DAY, since14 = ctx.now - 15 * DAY;
  const r = await db.batch([
    db.prepare('SELECT * FROM boxes'), db.prepare('SELECT * FROM tokens'), db.prepare('SELECT * FROM kv'),
    db.prepare("SELECT * FROM prospects WHERE status IN ('draft','active','sent_awaiting','replied','company_paused','ooo') OR status_at > ?").bind(new Date(since30).toISOString()),
    db.prepare("SELECT * FROM steps WHERE email IN (SELECT email FROM prospects WHERE status IN ('active','sent_awaiting','replied','company_paused','ooo') OR (status = 'complete' AND status_at > ?))").bind(new Date(since30).toISOString()),
    db.prepare('SELECT * FROM slots WHERE due_at > ? OR status = ?').bind(ctx.now - 2 * DAY, 'pending'),
    db.prepare('SELECT box,to_addr,at,kind,et_day FROM sends WHERE at > ?').bind(since30),
    db.prepare('SELECT email,reason,until FROM suppression'),
    db.prepare('SELECT at,kind,box,target,detail,alert FROM events WHERE at > ?').bind(since14),
    db.prepare("SELECT * FROM attempts WHERE status='claimed'"),
    db.prepare('SELECT mid FROM inbound WHERE at > ?').bind(ctx.now - 2 * DAY),   // recent only: every listed message is also checked by id against the whole inbound table (pollBatch), so a seen mid never ages out
    db.prepare('SELECT * FROM seeds WHERE sent_at > ?').bind(since14), db.prepare('SELECT * FROM box_creds')]);
  const [boxes, tokens, kv, prospects, steps, slots, sends, supp, events, claimed, inbound, seeds, creds] = r.map(x => x.results);
  const S = { boxes: {}, tokens: {}, kv: {}, P: {}, steps: {}, slots, sends, supp: {}, events, claimed, seen: new Set(inbound.map(x => x.mid)), seeds };
  for (const b of boxes) { b.strikes = JSON.parse(b.strikes || '[]'); S.boxes[b.email] = b; }
  for (const t of tokens) S.tokens[t.k] = t;
  for (const k of kv) S.kv[k.k] = k.v;
  XMAS_ONLY = S.kv.holiday_mode === 'christmas_only';
  for (const p of prospects) S.P[p.email] = p;
  S.PG = {}; for (const p of prospects) S.PG[gcanon(p.email)] ||= p;
  for (const s of steps) (S.steps[s.email] ||= [])[s.step] = s;
  for (const s of supp) S.supp[s.email] = s;
  ctx.S = S; ctx.cfg = zcfg(ctx.env); ctx.cfg.boxes ||= {};
  for (const c of creds) ctx.cfg.boxes[c.email] = { refresh_token: c.refresh_token, account_id: c.account_id, app: c.app || null };   // inboxes connected through /oauth/start
  return S;
}
const suppressed = (S, e, now) => [lc(e), '@' + dom(e)].some(k => { const s = S.supp[k]; return !!s && (!s.until || Date.parse(s.until) > now); });   // per address, or the whole company domain
const OPT_REASON = r => /^(stop|complaint)/.test(String(r || ''));
function suppress(ctx, email, reason, untilIso = null) {
  email = lc(email); const cur = ctx.S.supp[email];
  if (cur && !cur.until && untilIso) return;   // never downgrade a permanent suppression (stop, bounce, complaint) to a timed one
  if (cur && !cur.until && OPT_REASON(cur.reason) && !OPT_REASON(reason)) return;   // a later bounce never relabels an opt-out (the label drives erasure)
  ctx.S.supp[email] = { email, reason, until: untilIso };
  ctx.q("INSERT INTO suppression(email,reason,at,until) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET reason=excluded.reason, at=excluded.at, until=excluded.until WHERE suppression.until IS NOT NULL OR (excluded.until IS NULL AND NOT ((suppression.reason LIKE 'stop%' OR suppression.reason LIKE 'complaint%') AND NOT (excluded.reason LIKE 'stop%' OR excluded.reason LIKE 'complaint%')))", email, reason, new Date(ctx.now).toISOString(), untilIso);
}
function setP(ctx, p, fields) {
  Object.assign(p, fields, { status_at: new Date(ctx.now).toISOString() });
  const ks = Object.keys(fields).concat('status_at');
  ctx.q(`UPDATE prospects SET ${ks.map(k => k + '=?').join(',')} WHERE email=?`, ...ks.map(k => p[k] ?? null), p.email);
}
function setBox(ctx, b, fields) {
  Object.assign(b, fields); const ks = Object.keys(fields);
  ctx.q(`UPDATE boxes SET ${ks.map(k => k + '=?').join(',')} WHERE email=?`, ...ks.map(k => k === 'strikes' ? JSON.stringify(b[k]) : b[k] ?? null), b.email);
}
function cancelSlots(ctx, email, why) {
  for (const s of ctx.S.slots) if (s.email === email && s.status === 'pending' && s.kind !== 'thanks') { s.status = 'cancelled'; ctx.q("UPDATE slots SET status='cancelled', ref=? WHERE id=?", why, s.id); }
}

// ---------- Mailbox ----------
function zcfg(env) { const c = JSON.parse(env.MAILBOX_JSON || '{}'); let x = {}; try { x = JSON.parse(env.MAILBOX_APPS_JSON || '{}'); } catch { } c.apps = { ...(c.apps || {}), ...x }; return c; }   // per-group API apps live in their own secret, so the original MAILBOX_JSON is never rewritten
const appOf = (cfg, app) => (app && cfg.apps && cfg.apps[app]) || cfg;   // the API app (client_id/secret) an inbox was authorized with; no app = the original shared app
async function ztoken(ctx, email, force = false) {
  const S = ctx.S, t = S.tokens['z:' + email];
  if (!force && t && t.exp > ctx.now + 120000) return t.access;
  // Mailbox: "A total of 10 access token requests can be made within 10 minutes" (token-limits page; it does not say per refresh token, per user or per client).
  // the operator 14 Nov: each group of inboxes has its own Mailbox API app (cfg.apps, box_creds.app); the limit is counted per app: cap 4 per inbox and 9 per app per 10 min.
  let hits = []; try { hits = JSON.parse(S.kv.oauth_hits || '[]'); } catch { }
  hits = hits.map(x => Array.isArray(x) ? x : [x, '']).filter(x => x[0] > ctx.now - 600000);
  const c = ctx.cfg, b = c.boxes[email], app = b.app || '', k = appOf(c, b.app);
  if (hits.filter(x => x[1] === email).length >= 4 || hits.filter(x => (x[2] || '') === app).length >= 9) throw new AppBudget('oauth budget');
  const r = await ctx.f(ZACC + '/oauth/v2/token', { method: 'POST', body: new URLSearchParams({ refresh_token: b.refresh_token, client_id: k.client_id, client_secret: k.client_secret, grant_type: 'refresh_token' }) });
  const d = await r.json().catch(() => ({}));
  hits.push([ctx.now, email, app]); ctx.kv('oauth_hits', JSON.stringify(hits));
  if (!d.access_token) {
    if (/too many requests|access denied/i.test(`${d.error || ''} ${d.error_description || ''}`)) { hits.push(...Array(9).fill([ctx.now, '', app])); ctx.kv('oauth_hits', JSON.stringify(hits)); throw new AppBudget('mailbox oauth throttled: ' + (d.error_description || d.error)); }   // Mailbox's throttle reply: back off for 10 min instead of retrying into the lock
    if (/invalid_code|invalid_grant|invalid_token|invalid_client|unauthorized|access_denied/i.test(d.error || '') && S.boxes[email] && !paused(S.boxes[email], ctx.now)) pauseBox(ctx, S.boxes[email], ctx.now + DAY, `Mailbox refused the refresh token (${d.error}): re-authorize this inbox`);
    throw new Error(`mailbox token refresh failed for ${email}: ${r.status} ${d.error || ''}`);
  }
  const tok = { k: 'z:' + email, access: d.access_token, exp: ctx.now + (d.expires_in || 3600) * 1000 };
  S.tokens[tok.k] = tok; ctx.q('INSERT OR REPLACE INTO tokens(k,access,exp) VALUES(?,?,?)', tok.k, tok.access, tok.exp);
  return tok.access;
}
async function zapi(ctx, email, method, path, body) {
  for (let i = 0; i < 2; i++) {
    if (ctx.zcalls >= 22) throw new Budget('mailbox per-tick budget');
    const tok = await ztoken(ctx, email, i === 1); ctx.zcalls++;
    const r = await ctx.f(ZAPI + path, { method, headers: { Authorization: 'Mailbox-oauthtoken ' + tok, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let d = {}; try { d = JSON.parse(text.replace(/("(?:messageId|folderId|threadId|accountId)"\s*:\s*)(\d{16,})(?=\s*[,}\]])/g, '$1"$2"')); } catch { d = { raw: text.slice(0, 300) }; }   // ids are documented as strings; a bare 19-digit number would lose precision in JSON.parse and break threading
    if (!d || typeof d !== 'object') d = { raw: text.slice(0, 300) };   // JSON null / a bare number is not a usable body
    if (i === 0 && (r.status === 401 && /oauth|token|ticket/i.test(text) || r.status >= 400 && ZAUTH_RX.test(text))) continue;   // only an error response is an auth refusal: a 200 list whose message text quotes INVALID_TICKET must not force a token refresh on every poll
    return { s: r.status, d, text };
  }
}
const aidOf = (ctx, e) => ctx.cfg.boxes[e].account_id;
const ZAUTH_RX = /INVALID_OAUTHTOKEN|INVALID_TICKET|INVALID_OAUTHSCOPE|SCOPE_MISMATCH/;   // Mailbox auth refusals (sent as 404 or 400, with status.description "Invalid Input")
// Mailbox's list/metadata responses HTML-encode field values (official samples: toAddress "&quot;rebecca&quot;&lt;jane@example.net&gt;", summary "...&lt;jane@example.net&gt; wrote -")
const L1_ENT = 'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'.split(' ');
const NAMED_ENT = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', hellip: '…', bull: '•', euro: '€', trade: '™', OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š', Yuml: 'Ÿ', ...Object.fromEntries(L1_ENT.slice(1).map((n, i) => [n, String.fromCharCode(161 + i)])) };
// decodes numeric and HTML4 named references (an encoder that writes &atilde; / &ccedil; for Portuguese text must not hide "Não tenho interesse"),
// and repeats while something decodes (max 3 passes) so a double-encoded value (&amp;quot;) still compares equal to the subject we sent
const unent1 = t => t.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,7});/gi, (m, c) => { if (c[0] === '#') { const n = c[1] === 'x' || c[1] === 'X' ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m; } return NAMED_ENT[c] ?? NAMED_ENT[c.toLowerCase()] ?? m; });
const unent = t => { let s = String(t ?? ''); for (let k = 0; k < 3; k++) { const o = unent1(s); if (o === s) break; s = o; } return s; };
const zmsg = m => ({ ...m, summary: unent(m.summary), subject: unent(m.subject), fromAddress: unent(m.fromAddress), toAddress: unent(m.toAddress) });
const BLOCK_RX = /5\.4\.6|5\.1\.8|outgoing\s*block|unusual sending|sending limit|rate.?limit|limit exceed|quota|blocked|\b55[04][\s-]+5\.\d|unblockme/i;

// ---------- Google (digest, alerts, seed placement) ----------
async function gtoken(ctx, sub, scope) {
  const k = `g:${sub}:${scope}`, t = ctx.S.tokens[k];
  if (t && t.exp > ctx.now + 120000) return t.access;
  const sa = JSON.parse(ctx.env.GCP_SA), iat = Math.floor(ctx.now / 1000);
  const head = b64uStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64uStr(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/' + scope, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600, sub }));
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----|\s/g, '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head + '.' + claim)));
  const r = await ctx.f('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${b64u(sig)}` }) });
  const d = await r.json(); if (!d.access_token) throw new Error('google token failed ' + JSON.stringify(d).slice(0, 120));
  const tok = { k, access: d.access_token, exp: ctx.now + 3500 * 1000 }; ctx.S.tokens[k] = tok;
  ctx.q('INSERT OR REPLACE INTO tokens(k,access,exp) VALUES(?,?,?)', k, tok.access, tok.exp); return tok.access;
}
async function gmailSend(ctx, subject, text) {
  const tok = await gtoken(ctx, DIGEST_FROM, 'gmail.send');
  const raw = `From: Outbound Sequencer <${DIGEST_FROM}>\r\nTo: ${DIGEST_TO}\r\nSubject: ${/^[\x20-\x7e]*$/.test(subject) ? subject : '=?UTF-8?B?' + btoa(String.fromCharCode(...new TextEncoder().encode(subject))) + '?='}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
    btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/(.{76})/g, '$1\r\n');
  const r = await ctx.f('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: b64uStr(raw) }) });
  if (!r.ok) throw new Error('gmail send ' + r.status);
}

// ---------- DNS / verification ----------
async function mxClass(ctx, addr) {
  // Microsoft rule (the operator 2026-10-19): no sends to anything Microsoft-hosted. Catches consumer domains, direct M365 MX,
  // GoDaddy (secureserver.net = Microsoft 365 resold), and M365 hidden behind a filtering gateway (judged by the domain's SPF).
  const d = dom(addr);
  if (MS_CONSUMER.has(d) || /^(outlook|hotmail|live|msn|windowslive|passport)\.[a-z.]+$/.test(d)) return 'microsoft';
  const q = async (name, type) => { const r = await ctx.f(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: 'application/dns-json' } }); return r.json(); };
  try {
    const j = await q(d, 'MX'); if (j.Status === 3) return 'none'; if (j.Status !== 0) return 'error';
    const mx = (j.Answer || []).filter(a => a.type === 15).map(a => lc(a.data)).join(' ');
    if (!mx) return 'none';
    if (/protection\.outlook\.com|\.outlook\.com|hotmail\.com|secureserver\.net|\.mx\.microsoft\.?(\s|$)/.test(mx)) return 'microsoft';
    if (/(^|\s)\d+\s+\S*(google\.com|googlemail\.com)\.?(\s|$)/.test(mx) && !/protection\.outlook/.test(mx)) return 'google';
    // anything else (gateway, other host): look for Microsoft 365 behind it
    const t = await q(d, 'TXT'); if (t.Status !== 0 && t.Status !== 3) return 'error'; const spf = (t.Answer || []).map(a => lc(a.data)).join(' ');
    if (/spf\.protection\.outlook\.com/.test(spf)) return 'microsoft';
    return 'other';
  } catch (e) { if (e instanceof Budget) throw e; return 'error'; }
}
async function verifyAddr(ctx, addr) {   // Bouncer (the operator switched from MillionVerifier on 14 Oct 2026)
  const r = await ctx.f(`https://api.usebouncer.com/v1.1/email/verify?email=${encodeURIComponent(addr)}&timeout=10`, { headers: { 'x-api-key': ctx.env.BOUNCER_KEY } });
  const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch {}
  if (j.status === 'deliverable') return 'ok';
  if (j.status === 'risky' && (j.reason === 'accept_all' || (j.domain && j.domain.acceptAll === 'yes'))) return 'catch_all';
  if (j.status) return `${j.status}${j.reason ? ' (' + j.reason + ')' : ''}`;
  return `error (${r.status} ${(j.message || j.error || t).toString().slice(0, 60)})`;
}

// ---------- caps, ramp, gates ----------
function capOf(S, b, now) {
  let c = RAMP[Math.min(b.ramp_step || 0, RAMP.length - 1)];
  if (S.events.some(e => e.kind === 'block' && e.box === b.email && e.at > now - 7 * DAY)) c = Math.max(1, Math.floor(c / 2));   // halve for a week after a block
  return c;
}
const COUNTED = new Set(['step', 'seed', 'test']);
const sendsOn = (S, box, day) => S.sends.filter(s => s.box === box && s.et_day === day && COUNTED.has(s.kind));
function gates(S, b, now) {
  const wk = now - 7 * DAY, step = now - 14 * DAY;   // bounce/complaint/block gates cover the whole 10-sending-day step, not just the last week
  const sends = S.sends.filter(s => s.box === b.email && s.at > step && COUNTED.has(s.kind)).length;
  const hb = S.events.filter(e => e.kind === 'hard_bounce' && e.box === b.email && e.at > step).length;
  const why = [];
  if (S.events.some(e => e.kind === 'block' && e.box === b.email && e.at > step)) why.push('mailbox block during this step');
  if (!(hb === 0 || (hb <= 1 && hb / Math.max(sends, 1) < 0.02))) why.push(`${hb} hard bounce(s) on ${sends} sends`);
  if (S.events.some(e => e.kind === 'complaint' && e.box === b.email && e.at > step)) why.push('complaint');
  if ((b.ramp_step || 0) >= 1) {
    const sd = S.seeds.filter(x => x.box === b.email && x.sent_at > wk && x.placement);
    if (sd.some(x => x.placement === 'spam')) why.push('seed landed in spam');
    else if (!sd.some(x => x.placement === 'inbox')) why.push('no inbox seed result this week');
  }
  return why;
}
function rollover(ctx, etDay) {
  const S = ctx.S, prev = S.kv.last_rollover;
  if (prev === etDay) return;
  for (const b of Object.values(S.boxes)) {
    if (b.parked) continue;
    const ca = +(S.kv['cold_off_auto:' + b.email] || 0);
    const lastB = ca && Math.max(ca, ...S.events.filter(e => e.kind === 'block' && e.box === b.email).map(e => e.at));
    if (b.cold_off && ca && ctx.now - lastB >= 14 * DAY) {   // 14 days counted from the latest block
      const rs = Math.max(0, (b.ramp_step || 0) - 1);
      setBox(ctx, b, { cold_off: 0, ramp_step: rs, step_days: 0, strikes: [] }); ctx.kv('cold_off_auto:' + b.email, '0');
      ctx.ev('cold_back', b.email, null, `back on cold sending after 14 days without a Mailbox block, cap ${RAMP[rs]}/day`, 1);
    }
    if (prev && sendsOn(S, b.email, prev).some(x => x.kind === 'step')) b.step_days = (b.step_days || 0) + 1;   // only days it sent real cold count (tests and seeds do not)
    let fields = { step_days: b.step_days || 0 };
    if (fields.step_days >= (STEP_DAYS_AT[b.ramp_step || 0] ?? STEP_DAYS) && (b.ramp_step || 0) < RAMP.length - 1) {
      const why = gates(S, b, ctx.now);
      if (!why.length) { fields = { ramp_step: (b.ramp_step || 0) + 1, step_days: 0 }; ctx.ev('ramp_up', b.email, null, `cap now ${RAMP[fields.ramp_step]}/day`); }
      else ctx.ev('ramp_hold', b.email, null, why.join('; '));
    }
    setBox(ctx, b, fields);
  }
  // company pauses expire after 14 days without a further reply
  // colleagues paused by a reply stay paused: a live conversation is never interrupted by an automatic email (the operator resumes them by hand)
  ctx.q('DELETE FROM events WHERE at < ? AND alert = 0', ctx.now - 120 * DAY);
  ctx.q("UPDATE inbound SET from_addr=NULL, subject=NULL, detail=NULL WHERE at < ? AND from_addr IS NOT NULL", ctx.now - 365 * DAY);   // keep only the message id (dedupe) after a year
  ctx.q("UPDATE events SET target=NULL, detail=NULL WHERE at < ? AND (target IS NOT NULL OR detail IS NOT NULL)", ctx.now - 365 * DAY);   // alert events with no target (cold_off_ended, bounce_unreadable) list addresses in detail and are never pruned
  // "stop ... and will delete your details": people who opted out keep only the suppression row (sends.to_addr kept 32 days for the bounce/cap maths)
  const t3 = new Date(ctx.now - pendDays(ctx.S) * DAY + 1).toISOString();   // an opt-out is erased once the undo window (PENDING_DAYS) has passed
  const OPTED = `SELECT email FROM suppression WHERE until IS NULL AND (reason LIKE 'stop%' OR reason LIKE 'complaint%') AND (at < '${t3}' OR reason LIKE '% (company)' OR reason LIKE '% (company name)')`;   // round 22a: '(company)' rows are written only when the company stop is applied (wait over or confirmed): no second wait
  // GDPR retention (privacy notice): opted-out EU/UK contacts keep only the suppression row; everyone else is erased 12 months after their last status change.
  // An opt-out is the suppression row, not prospects.status: a stop that arrives after the prospect left the loaded set (complete > 31 days), an address named
  // in someone else's opt-out while complete/replied, or a later bounce leave the status at complete/replied/bounced. Every status ages out after 12 months.
  const y1 = new Date(ctx.now - 365 * DAY).toISOString(), GONE = `SELECT email FROM prospects WHERE (COALESCE(country,'US') != 'US' AND ((status='stopped' AND status_at < '${t3}') OR email IN (${OPTED}))) OR status_at < ?`;
  ctx.q(`DELETE FROM steps WHERE email IN (${GONE})`, y1);
  ctx.q(`DELETE FROM prospects WHERE email IN (${GONE})`, y1);
  ctx.q("UPDATE sends SET to_addr=NULL WHERE at < ? AND to_addr IS NOT NULL", ctx.now - 365 * DAY);
  ctx.q("DELETE FROM attempts WHERE status != 'claimed' AND claimed_at < ? AND email NOT IN (SELECT email FROM prospects)", ctx.now - 365 * DAY);
  ctx.q("DELETE FROM suppression WHERE until IS NOT NULL AND until < ?", new Date(ctx.now).toISOString());   // an expired timed suppression (sequence_complete) protects nobody and only keeps the address
  ctx.q("DELETE FROM seeds WHERE sent_at < ?", ctx.now - 365 * DAY);
  ctx.q("DELETE FROM kv WHERE k LIKE 'dnsfail:%' AND substr(k, 9) NOT IN (SELECT email FROM prospects)");
  ctx.q("DELETE FROM slots WHERE due_at < ? AND status != 'pending'", ctx.now - 60 * DAY);
  // round 22a: a complaint event keeps a pseudonymous sender key (h:<hash>, not the address) for 8 days so complaintCount7 still sees it after erasure
  for (const x of S.events) if (x.kind === 'complaint' && x.target && !/^h:/.test(x.target) && x.at < ctx.now - 2 * DAY && x.at > ctx.now - 8 * DAY) ctx.q(`UPDATE events SET target=?, detail=NULL WHERE kind='complaint' AND target=? AND at=? AND target IN (${OPTED})`, ckey(x.target), x.target, x.at);
  ctx.q("UPDATE events SET target=NULL WHERE kind='complaint' AND target LIKE 'h:%' AND at < ?", ctx.now - 8 * DAY);
  ctx.q(`UPDATE events SET target=NULL, detail=NULL WHERE target IN (${OPTED}) AND at < ?`, ctx.now - 2 * DAY);
  ctx.q(`UPDATE inbound SET from_addr=NULL, subject=NULL, detail=NULL WHERE from_addr IN (${OPTED}) AND at < ? AND NOT (detail LIKE 'DATA REQUEST%' AND at > ?)`, ctx.now - 2 * DAY, ctx.now - 31 * DAY);   // a data request is answered within one month (Art. 12(3)), so its sender address is kept that long
  ctx.q(`DELETE FROM attempts WHERE email IN (${OPTED}) AND status != 'claimed'`);
  ctx.q(`DELETE FROM slots WHERE email IN (${OPTED}) AND status != 'pending'`);
  ctx.q(`UPDATE sends SET to_addr=NULL WHERE to_addr IN (${OPTED}) AND at < ?`, ctx.now - 32 * DAY);
  ctx.kv('last_rollover', etDay);
}

// ---------- inbound ----------
function parseReturn(text, today) {
  const t = lc(text);
  const mo = t.match(/(?:back|return\w*|until|through|thru)\D{0,25}\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/);
  const nu = t.match(/(?:back|return\w*|until|through|thru)\D{0,25}\b(\d{1,2})\/(\d{1,2})\b/);
  let m, d; if (mo) { m = 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(mo[1]) / 3 + 1; d = +mo[2]; } else if (nu) { m = +nu[1]; d = +nu[2]; } else return null;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  let y = +today.slice(0, 4), cand = `${y}-${pad(m)}-${pad(d)}`; if (cand < today) cand = `${y + 1}-${pad(m)}-${pad(d)}`;
  if (cand > addDays(today, 60)) return null;
  return addBusinessDays(cand, 1);
}
function headerMap(d) {
  const o = d && d.data ? (d.data.headerContent || d.data) : {}; const H = {};
  if (typeof o === 'string') { for (const line of o.split(/\r?\n/)) { const i = line.indexOf(':'); if (i > 0) H[lc(line.slice(0, i))] = line.slice(i + 1).trim(); } return H; }
  for (const [k, v] of Object.entries(o || {})) H[lc(k)] = Array.isArray(v) ? v.join(' ') : String(v);
  return H;
}
async function poll(ctx, etDay) {
  const S = ctx.S; let extra = 0;
  // Rotate through inboxes a few per tick so every box gets polled and sending keeps Mailbox budget (27 boxes > 22 calls per tick).
  const all = Object.values(S.boxes).filter(b => ctx.cfg.boxes?.[b.email]);
  if (!all.length) return;
  // inboxes with live threads (sent in the last 21 days) get most of the polling, idle ones keep a slice; both rotate so every inbox is reached
  const hot = all.filter(b => S.sends.some(x => x.box === b.email && ['step', 'reply'].includes(x.kind) && x.at > ctx.now - 21 * DAY));
  const cold = all.filter(b => !hot.includes(b));
  const nCold = Math.min(cold.length, hot.length ? Math.max(4, POLL_PER_TICK - hot.length) : POLL_PER_TICK), nHot = Math.min(hot.length, POLL_PER_TICK - nCold);   // r26: idle inboxes get at least 4 per tick
  const curs = [];   // cursors only advance past inboxes actually polled, so a budget cut never skips anyone
  const take = (list, n, key) => { const st = list.length ? (parseInt(S.kv[key] || '0', 10) || 0) % list.length : 0; const c = { key, st, len: list.length, done: 0 }; curs.push(c); return Array.from({ length: n }, (_, i) => ({ b: list[(st + i) % list.length], c })); };
  // r26: before a cold send is due, every inbox read more than 30 min ago is polled first (sendOne needs ALL inboxes read within 45 min)
  const due = !isSendingDay(etDay) || S.slots.some(s => s.status === 'pending' && s.kind !== 'seed' && s.due_at <= ctx.now + 15 * 60000);   // r27: off-hours (one tick per 30 min) oldest-first too, or the busy inboxes' Spam checks leave the idle ones unread for 5 h
  const urgent = due ? all.filter(b => ctx.now - (+(S.kv['poll_ok:' + b.email] || 0)) > 30 * 60000).sort((x, y) => (+(S.kv['poll_ok:' + x.email] || 0)) - (+(S.kv['poll_ok:' + y.email] || 0))).slice(0, POLL_PER_TICK) : [];
  const batch = urgent.map(b => ({ b, c: { done: 0 } })).concat(take(hot, nHot, 'poll_hot_cursor').concat(take(cold, nCold, 'poll_cursor')).filter(x => !urgent.includes(x.b)));
  ctx.out.push('poll: ' + batch.map(x => x.b.email).join(' '));
  try { await pollBatch(ctx, etDay, batch); } finally { for (const c of curs) if (c.len) ctx.kv(c.key, String((c.st + c.done) % c.len)); }
}
async function pollBatch(ctx, etDay, batch) {
  const S = ctx.S; let extra = 0;
  const appKey = e => ctx.cfg.boxes?.[e]?.app || '', spent = new Set();   // API apps whose OAuth limit ran out this tick
  for (const { b, c } of batch) {
    if (ctx.zcalls >= POLL_ZCALLS) return;
    if (spent.has(appKey(b.email))) continue;
    const e = b.email, aid = aidOf(ctx, e); c.done++;
    let res; try { res = await zapi(ctx, e, 'GET', `/accounts/${aid}/messages/view?limit=40`); } catch (err) { if (err instanceof Budget) { c.done--; if (!(err instanceof AppBudget)) return; spent.add(appKey(e)); if (!batch.some(x => !spent.has(appKey(x.b.email)))) return; continue; }   // not polled (token budget); one app out of OAuth budget only skips that app's inboxes: the cursor must not move past it, or it waits a whole extra rotation
      ctx.ev('poll_error', e, null, String(err)); continue; }
    if (res.s !== 200 || !Array.isArray(res.d && res.d.data)) { ctx.ev('poll_error', e, null, `${res.s} ${res.text.slice(0, 150)}`); continue; }   // a 200 that is not a JSON list (HTML page) is a failed poll, not an empty inbox
    let msgs = res.d.data.map(zmsg);
    // the list is newest first, 40 per page: if the OLDEST listed message is still unseen, more than a page arrived since the last poll
    // (listing outage, OAuth throttle, slow off-hours polling): page back until a seen one, or older mail would never be listed again
    for (let pg = 1; pg < 6 && msgs.length === 40 * pg; pg++) {
      const old = msgs[msgs.length - 1], oid = String(old.messageId);
      if (S.seen.has(oid) || (+old.receivedTime && +old.receivedTime < (b.poll_since || 0)) || await ctx.db.prepare('SELECT 1 FROM inbound WHERE mid=?').bind(oid).first()) break;
      let r2; try { r2 = await zapi(ctx, e, 'GET', `/accounts/${aid}/messages/view?limit=40&start=${40 * pg + 1}`); } catch (err) { if (err instanceof Budget) { c.done--; (ctx.unread ||= new Set()).add(e); ctx.kv('poll_partial:' + e, String(ctx.now)); return; } throw err; }
      if (r2.s !== 200 || !Array.isArray(r2.d && r2.d.data)) { ctx.ev('poll_error', e, null, `page ${pg + 1}: ${r2.s} ${r2.text.slice(0, 150)}`); (ctx.unread ||= new Set()).add(e); ctx.kv('poll_partial:' + e, String(ctx.now)); msgs = null; break; }   // process nothing: marking page 1 seen would stop the next poll from paging back to the unread older pages
      msgs = msgs.concat(r2.d.data.map(zmsg));
      if (pg === 5 && r2.d.data.length === 40) ctx.ev('poll_overflow', e, null, `over 240 unread messages since the last poll: older ones are not listed; read this inbox by hand`, 1);
    }
    if (!msgs) continue;
    // the whole listing was read: only now is this inbox "polled" for the send gate (a page-1-only read with unread older pages is not, on any later tick either, until paging succeeds)
    ctx.kv('poll_ok:' + e, String(ctx.now));   // send gate (sendOne): no cold send from an inbox whose replies we can't currently read
    if (S.kv['poll_partial:' + e]) { delete S.kv['poll_partial:' + e]; ctx.q('DELETE FROM kv WHERE k=?', 'poll_partial:' + e); }
    ctx.out.push(`${e}: ${msgs.length} msgs`);
    if (ctx.now - (+(S.kv['spam_at:' + e] || 0)) >= 30 * 60000 && ctx.zcalls <= POLL_ZCALLS - 2) {   // the default list skips Spam; check it every 30 min per inbox (r26: spread over ticks so it never starves the rotation)
      try {
        if (!b.spam_folder) { const f = await zapi(ctx, e, 'GET', `/accounts/${aid}/folders`); for (const x of (Array.isArray(f.d.data) ? f.d.data : [])) { if (x.folderType === 'Spam' || x.folderName === 'Spam') setBox(ctx, b, { spam_folder: String(x.folderId) }); if (x.folderType === 'Sent' || x.folderName === 'Sent') setBox(ctx, b, { sent_folder: String(x.folderId) }); } }
        if (!b.spam_folder) ctx.kv('spam_at:' + e, String(ctx.now));   // r27: no Spam folder found: look again in 30 min, not on every poll
        if (b.spam_folder) { const sp = await zapi(ctx, e, 'GET', `/accounts/${aid}/messages/view?folderId=${b.spam_folder}&limit=20`); msgs = msgs.concat((Array.isArray(sp.d.data) ? sp.d.data : []).map(x => ({ ...zmsg(x), _spam: 1 }))); if (sp.s === 200) ctx.kv('spam_at:' + e, String(ctx.now)); }
      } catch (err) { if (err instanceof Budget) { c.done--; (ctx.unread ||= new Set()).add(e); return; } }   // listed but not processed: re-polled first next tick, no send from it this tick
    }
    const ids = [...new Set(msgs.map(m => String(m.messageId)))].filter(id => !S.seen.has(id));
    if (ids.length) { const known = await ctx.db.prepare(`SELECT mid FROM inbound WHERE mid IN (${ids.map(() => '?').join(',')})`).bind(...ids).all(); for (const r of known.results || []) S.seen.add(String(r.mid)); }
    for (const m of msgs.reverse()) {
      const mid = String(m.messageId); if (S.seen.has(mid)) continue;
      const recv = +m.receivedTime || 0, from = lc(m.fromAddress), subj = m.subject || '', summ = m.summary || '';
      const mark = (kind, detail = '') => { S.seen.add(mid); ctx.q('INSERT OR IGNORE INTO inbound(mid,box,from_addr,subject,kind,at,detail) VALUES(?,?,?,?,?,?,?)', mid, e, from, subj.slice(0, 200), kind, recv || ctx.now, String(detail).slice(0, 300)); };
      if (recv && recv < (b.poll_since || 0)) { mark('pre_baseline'); continue; }
      if (recv && recv < ctx.now - 60 * DAY) { mark('stale'); ctx.ev('inbound_stale', e, from, `${subj} | received ${new Date(recv).toISOString().slice(0, 10)} | reply id ${m.messageId}`, 1); continue; }   // never act on old mail; surface it once
      if (from === e) { mark('own'); continue; }
      const isBounce = /mailer-daemon|postmaster/.test(from) || (/undeliver|returned to sender|delivery status notification|failure notice|delivery has failed|could not be delivered/i.test(subj) && !/^\s*(re|res|aw|antw|sv|r|enc|fw|fwd|wg|tr)\s*:/i.test(subj));   // r22b: "FW: Undeliverable: ..." with a note from a person is that person writing
      let p = S.P[from] || S.PG?.[gcanon(from)], amb = null;
      if (!p && /^\s*(re|res|aw|antw|sv|r|enc|fw|fwd)\s*:/i.test(subj)) {   // reply/forward from a colleague on the same domain, matched on our subject
        const norm = lc(subj.replace(/^\s*((re|res|aw|antw|sv|r|enc|fw|fwd)\s*:\s*)+/i, ''));
        const cands = Object.values(S.P).filter(x => x.box === e && lc(S.steps[x.email]?.[0]?.subject) === norm);
        p = cands.find(x => dom(x.email) === dom(from) && !FREEMAIL.has(dom(from)) && !MS_CONSUMER.has(dom(from))) || (cands.length === 1 ? cands[0] : null);   // a shared freemail domain (gmail.com) is not a company match   // same company first; else the only thread with that subject
        if (!p && cands.length > 1) amb = cands;   // several threads share this subject: we can't tell whose reply (or opt-out) this is
      }
      if (!isBounce && !p) {
        // safety net: a human writing to a sending inbox is never dropped silently
        const sys0 = /(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?@|@providercorp\.|^(support|zmteam|team|alerts?|security|accounts?|billing|feedback|newsletter|marketing|updates?)@mailbox(mail)?\.|provideraccounts|@google\.com|@accounts\.google)/i.test(from) || from === e;   // r25a: a personal @providermail.eu / @mailbox.com mailbox (FREEMAIL) is a person, not a Mailbox system notice
        // "related": the sender's company (or, for a freemail sender, the address itself) was emailed, or the subject is one of ours.
        // Junk from strangers (phishing "legal action", newsletters with "unsubscribe") must never trigger the global stop or flood the alert inbox.
        const d0 = dom(from), fm0 = FREEMAIL.has(d0) || MS_CONSUMER.has(d0), sj0 = lc(ownSubj(subj));
        const related = S.sends.some(s => s.to_addr && (fm0 ? lc(s.to_addr) === from : dom(s.to_addr) === d0)) || (!fm0 && Object.values(S.P).some(x => dom(x.email) === d0)) ||
          (!!sj0 && Object.values(S.steps).some(x => lc(x?.[0]?.subject || '') === sj0));
        const nm = t => [...new Set((t + ' ' + subj).toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+/g) || [])].map(a => S.P[a]).filter(x => x && x.email !== from);
        let own = ownText(summ), namedRaw = sys0 ? [] : nm(own), rawT = summ;
        const spamJunk = () => m._spam && !related && !namedRaw.length && !/^\s*(re|res|aw|antw|sv|r|enc|fw|fwd)\s*:/i.test(subj) && !humanStop(own, subj) && !COMPLAINT_RX.test(own) &&
            !Object.values(S.P).some(x => ['active', 'ooo', 'draft', 'company_paused'].includes(x.status) && mentionsAny(own, subj, x, S.steps[x.email]?.[0]?.subject, rawT));
        // r25a: the listing summary is a ~200-character preview: a person's opt-out in Spam can ask to stop (or name the business) after the cut. Read it whole before dropping it.
        if (spamJunk() && !sys0 && summ.length >= 100) {
          try { const c = await zapi(ctx, e, 'GET', `/accounts/${aid}/folders/${m.folderId}/messages/${m.messageId}/content`); const h = c.s === 200 && c.d && c.d.data && typeof c.d.data.content === 'string' ? c.d.data.content : '';
            if (h.trim()) { rawT = htmlText(h); own = ownText(rawT); namedRaw = nm(own); } }
          catch (err) { if (err instanceof Budget) { (ctx.unread ||= new Set()).add(e); continue; } }   // left unseen: re-read at the next Spam check, no send from this inbox this tick
        }
        if (spamJunk()) {   // r24: Spam junk that names none of our businesses and asks nothing   // r24b: a person's opt-out that landed in Spam is processed like any other
          mark('spam_other', summ.slice(0, 200)); ctx.ev('spam_unmatched', e, from, subj.slice(0, 150)); continue; }   // listed in the digest, no alert
        // r22b: the listing summary is a preview (about 200 characters): a long message from a personal address or a related sender can ask to stop, or name the address, after the cut. Read it whole.
        if (!sys0 && !m._spam && summ.length >= 100 && (summ.search(QUOTE_RX) < 0 || STOP_RX.test(own) || COMPLAINT_RX.test(own) || STOP_RX.test(ownSubj(subj)))) {
          try { const c = await zapi(ctx, e, 'GET', `/accounts/${aid}/folders/${m.folderId}/messages/${m.messageId}/content`); const h = c.s === 200 && c.d && c.d.data && typeof c.d.data.content === 'string' ? c.d.data.content : '';
            if (h.trim()) { rawT = htmlText(h); own = ownText(rawT); namedRaw = nm(own); } }
          catch (err) { if (err instanceof Budget) { (ctx.unread ||= new Set()).add(e); continue; } }   // left unseen: re-read next tick
        }
        const optText = STOP_RX.test(own) || COMPLAINT_RX.test(own) || STOP_RX.test(ownSubj(subj));
        // r22b: an opt-out from a no-reply-looking or platform address (a helpdesk relay, a personal @providermail.eu box) that names a prospect, or comes from a prospect's own domain, is a person, not a system notice
        const system = sys0 && !/mailer-daemon|postmaster/.test(from) && from !== e && (nm(own).length > 0 || (optText && !fm0 && Object.values(S.P).some(x => dom(x.email) === d0)) || (optText && Object.values(S.P).some(x => ['active', 'ooo', 'draft'].includes(x.status) && mentionsAny(own, subj, x, S.steps[x.email]?.[0]?.subject, rawT)))) ? false : sys0;
        if (sys0 && !system) namedRaw = nm(own);
        const optOut = !system && optText;
        // r22b: an opt-out from an address we never emailed that names a prospect's website / domain or company ("sou a dona da Clínica Costa, parem de enviar", "stop emailing clinicacosta.pt") holds that prospect until the operator looks
        const mention = !system && !AUTO_SUBJ_RX.test(subj) ? Object.values(S.P).filter(x => x.email !== from && !namedRaw.includes(x) && (fm0 || dom(x.email) !== d0) && ['active', 'ooo', 'draft'].includes(x.status) && mentionsAny(own, subj, x, S.steps[x.email]?.[0]?.subject, rawT)) : [];
        // r24b: only weak ties (near name / shared subject): hold every prospect whose distinctive name words appear too, the right one may not be the one tied
        if (optOut && mention.length && !namedRaw.length && !mention.some(x => mentionsAny(own, subj, x, S.steps[x.email]?.[0]?.subject, rawT, true))) for (const x of Object.values(S.P)) if (!mention.includes(x) && x.email !== from && (fm0 || dom(x.email) !== d0) && ['active', 'ooo', 'draft'].includes(x.status) && coShare(own + '\n' + ownSubj(subj), x.company || '')) mention.push(x);
        // a prospect address written out in the message ("please stop emailing info@example.pt", sent from the owner's gmail or the company's accountant) is that prospect's thread
        const named = system || AUTO_SUBJ_RX.test(subj) ? [] : namedRaw;
        const coLive = !system && !optOut && !fm0 && !amb && !AUTO_SUBJ_RX.test(subj) && Object.values(S.P).some(x => dom(x.email) === d0 && x.status === 'active');
        let coAuto = false;
        if (coLive) {   // only the rare same-company message pays for a header read: a helpdesk/out-of-office auto-reply must not hold anyone
          try { const r = await zapi(ctx, e, 'GET', `/accounts/${aid}/folders/${m.folderId}/messages/${m.messageId}/header?raw=false`); coAuto = !!autoHdr(headerMap(r.d)); }
          catch (err) { if (err instanceof Budget) { (ctx.unread ||= new Set()).add(e); continue; } }   // left unseen: re-read next tick, sends from this inbox wait (sendOne)
        }
        if (optOut) {   // an opt-out is honoured even when we can't tie it to a sequence
          const cmpWords = COMPLAINT_RX.test(own), cmp = cmpWords && related, d = dom(from);
          suppress(ctx, from, cmp ? 'complaint (unmatched thread)' : 'stop (unmatched thread)');
          let held = '';
          if (!FREEMAIL.has(d) && !MS_CONSUMER.has(d)) held = companyHold(ctx, { email: from, company: null }, from, cmp ? 'complaint' : 'stop');   // a colleague's "stop" speaks for the company: held now, blocked after the wait
          for (const o of named) { suppress(ctx, o.email, 'stop (named in an opt-out)'); if (['active', 'company_paused', 'ooo', 'draft'].includes(o.status)) { setP(ctx, o, { status: 'stopped', note: 'opt-out from ' + from + ' named this address' }); cancelSlots(ctx, o.email, 'named stop'); } held += companyHold(ctx, o, o.email, 'stop'); }
          for (const o of mention) {   // r23a: the opt-out names this business: held now, company stop pending like any other stop (blocked after the wait unless the operator undoes it)
            setP(ctx, o, { status: 'company_paused', note: `held: stop from ${from} (company stop pending; the opt-out names this company or site)` }); cancelSlots(ctx, o.email, 'opt-out names company');
            held += ` | HELD (the opt-out names their company or site): ${o.email}` + companyHold(ctx, o, from, 'stop'); }
          if (cmpWords && !cmp) ctx.ev('possible_complaint', e, from, 'complaint wording from a sender we never emailed (no global stop; set kill by hand if it is real): ' + own.slice(0, 200), 1);
          else { const n7 = cmp ? complaintCount7(ctx, from) : 0; ctx.ev(cmp ? 'complaint' : 'stop', e, from, dsrTag(own) + 'unmatched thread: ' + own.slice(0, 200) + held + (cmp && n7 < killN(S) ? ' | first complaint in 7 days: sending CONTINUES for other companies' : ''), 1);
            if (cmp && n7 >= killN(S)) { ctx.kv('kill', (`auto: complaint from ${from} (${n7} complaints in 7 days)` + (/^auto: hold:/.test(String(S.kv.kill || '')) ? ' | ' + S.kv.kill : '')).slice(0, 1500)); ctx.ev('kill', null, null, `global stop: ${n7} complaints in 7 days (unmatched thread)`, 1); } }
        }
        if (coLive && !coAuto) {   // a colleague answered from an address we never emailed, on a new subject (often after an internal "FYI" forward): it speaks for the company, so nobody there gets a follow-up until the operator looks
          const held = [];
          for (const o of Object.values(S.P)) if (dom(o.email) === d0 && o.status === 'active') { setP(ctx, o, { status: 'company_paused', note: `held: ${from} (same company) wrote from an address we did not email (set back to active by hand if the sequence should continue)` }); cancelSlots(ctx, o.email, 'colleague wrote'); held.push(o.email); }
          if (held.length) ctx.ev('colleague_hold', e, from, `same-company message on a new subject; follow-ups held for: ${held.join(', ')}`, 1);
        }
        if (!optOut && mention.length) {   // r22b: someone wrote about a prospect's company or site from an address we never emailed: no follow-up to it until the operator looks
          for (const o of mention) { setP(ctx, o, { status: 'company_paused', note: `held: ${from} wrote about this company or site (set back to active by hand if the sequence should continue)` }); cancelSlots(ctx, o.email, 'company named in a message'); }
          ctx.ev('colleague_hold', e, from, `message naming the company or site of ${mention.map(o => o.email).join(', ')} from an address we did not email; follow-ups held`, 1);
        }
        if (!optOut && named.length) {   // someone wrote about a prospect's address from an address we never emailed: no follow-up to that prospect until the operator looks
          const held = named.filter(o => o.status === 'active'); for (const o of held) { setP(ctx, o, { status: 'company_paused', note: `held: ${from} wrote about this address (set back to active by hand if the sequence should continue)` }); cancelSlots(ctx, o.email, 'named in a message'); }
          if (held.length) ctx.ev('colleague_hold', e, from, `message naming ${held.map(o => o.email).join(', ')} from an address we did not email; follow-ups held`, 1);
        }
        if (amb && !system) {   // a reply or "stop" from an address we never emailed, on a subject several threads share: hold every candidate so no follow-up lands on the person who answered
          const held = [];
          for (const o of amb) if (o.status === 'active') { setP(ctx, o, { status: 'company_paused', note: `held: ${from} answered on this subject from an address we did not email (set back to active by hand if it was not this thread)` }); cancelSlots(ctx, o.email, 'ambiguous reply'); held.push(o.email); }
          if (held.length) ctx.ev('ambiguous_hold', e, from, `reply on a subject shared by ${amb.length} threads; follow-ups held for: ${held.join(', ')}`, 1);
        }
        // r24 (the operator, 24 Oct 2026: stop guessing): a message from an address we never emailed, on a cold inbox, or an opt-out on any inbox, pauses ALL cold
        // sending until the operator reads it. Ties above still hold the businesses they name, but nothing depends on the tie being right. A system sender
        // (no-reply, Mailbox, Google) only pauses when its own text asks to stop.
        const coldBox = S.boxes[e]?.lane === 'branda' || !S.boxes[e]?.warm_only;
        // r32 (the operator, 10 Nov 2026: "narrow it"): with kv stranger_pause=optout a stranger pauses ALL cold sending only when the message asks to stop or complains;
        // auto-replies and normal replies (contact-form traffic into the cold inboxes) alert the operator as inbound_unmatched and sending carries on
        // r34 (the operator, 10 Nov 2026: "we don't need to pause the sequencer we just stop email that particular person"): with kv stranger_pause=complaint a stranger's
        // plain opt-out ("not interested", "stop") is suppressed and alerted above and sending carries on; only complaint wording (COMPLAINT_RX) pauses ALL cold sending
        const narrow = S.kv.stranger_pause === 'optout', cmpOnly = S.kv.stranger_pause === 'complaint', sysStop = system && !/mailer-daemon|postmaster/.test(from) && humanStop(own, subj);
        if (cmpOnly ? (COMPLAINT_RX.test(own) && (!system || sysStop)) : ((!system && (narrow ? optOut : (coldBox || optOut))) || sysStop))
          strangerPause(ctx, e, from, subj, own, [...named, ...mention, ...(amb || [])].map(o => o.email));
        if (!system && coldBox) { mark('unmatched', dsrTag(own) + summ.slice(0, 200)); ctx.ev('inbound_unmatched', e, from, `${dsrTag(own)}${subj} | ${summ.slice(0, 300)} | reply id ${m.messageId}`, 1); }
        else mark('other');
        continue;
      }
      if (extra >= 8) { (ctx.unread ||= new Set()).add(e); break; }   // stop here: newer messages marked seen would push this one off page 1 where paging cannot reach it   // leave unseen; next tick picks it up (sends from this inbox wait for it: sendOne)
      extra++;
      try {
        if (isBounce) await onBounce(ctx, b, m, mark, etDay);
        else { if (!S.P[from] && !S.PG?.[gcanon(from)] && from !== lc(p.email) && (S.boxes[e]?.lane === 'branda' || !S.boxes[e]?.warm_only)) strangerPause(ctx, e, from, subj, ownText(summ), [p.email]);   // r24: matched on our subject only (r25b: before onReply, so an error in it cannot skip the pause)
          await onReply(ctx, b, m, p, mark, etDay); }
      } catch (err) { if (err instanceof Budget) { (ctx.unread ||= new Set()).add(e); return; } ctx.ev('inbound_error', e, from, String(err)); }
    }
  }
}
// r24: pause ALL cold sending for a message from an address we never emailed; always alert (also when sending is already stopped), and keep every
// such sender in the kill reason so a resume is a decision about all of them. The harness turns this off for legacy suites (kv stranger_pause=off).
function strangerPause(ctx, e, from, subj, text, tied = []) {
  const S = ctx.S; if (S.kv.stranger_pause === 'off') return;
  const r = `auto: hold: message from ${from} (an address we never emailed)`, cur = String(S.kv.kill || '');
  if (!killed(S)) ctx.kv('kill', r); else if (/^auto:/.test(cur) && !cur.includes(r)) ctx.kv('kill', (cur + ' | ' + r).slice(0, 1500));
  ctx.ev('kill', null, from, `ALL COLD SENDING PAUSED: ${from} wrote to ${e} and we never emailed that address. Subject: "${String(subj || '').slice(0, 150)}" | text: "${String(text || '').slice(0, 300)}"` +
    (tied.length ? ` | held because the message names them: ${[...new Set(tied)].join(', ')}` : '') + ` | read it in ${e}. If it asks a business to stop: seqadmin stop {"email":"<prospect address>"}. Then resume: seqadmin kill {"on":false}`, 1);
}
async function onBounce(ctx, b, m, mark, etDay) {
  const S = ctx.S, e = b.email, r = await zapi(ctx, e, 'GET', `/accounts/${aidOf(ctx, e)}/messages/${m.messageId}/originalmessage`);
  const fk = 'bfail:' + m.messageId;
  if (r.s !== 200) {   // never mark a bounce we could not read on a passing error; after 3 failed reads judge it from the listing summary and tell the operator once
    const n = (+(S.kv[fk] || 0)) + 1;
    if (n < 3) { ctx.kv(fk, String(n)); throw new Error(`bounce body fetch ${r.s}: retried next tick (${n}/3)`); }
    ctx.ev('bounce_unreadable', e, null, `${m.subject || ''} | bounce body fetch failed 3 times (${r.s}); judged from the listing summary: ${String(m.summary || '').slice(0, 200)}`, 1);
  }
  if (S.kv[fk]) { delete S.kv[fk]; ctx.q('DELETE FROM kv WHERE k=?', fk); }
  const raw = (r.s === 200 ? String((r.d.data && (r.d.data.content || r.d.data)) || r.text || '') : '') + '\n' + (m.summary || '');
  const finals = [...raw.matchAll(/Final-Recipient:\s*rfc822;\s*<?([^\s>;]+@[^\s>;]+)>?/gi)].map(x => lc(x[1]));
  const status = (raw.match(/^\s*Status:\s*([245])\.\d{1,3}\.\d{1,3}/mi) || [])[1];
  const sentTo = [...new Set(S.sends.filter(s => s.box === e && s.to_addr).map(s => lc(s.to_addr)))];   // an erased (NULL) address would match any text
  const low = lc(raw), esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), rcpts = finals.length ? finals : sentTo.filter(a => new RegExp('(^|[^a-z0-9._%+-])' + esc(a) + '($|[^a-z0-9.-])').test(low));
  if (/^\s*Action:\s*delayed/mi.test(raw) || /\(delay\)|delayed|will retry|atrasad|adiad/i.test(m.subject || '')) { mark('delay_notice', m.subject); ctx.ev('delay_notice', e, null, m.subject); return; }   // a delay is not a failure
  const soft = status === '4';
  if (!rcpts.length) {
    const t = ownText(String(m.summary || '')), from = lc(m.fromAddress), d = dom(from);
    if (!/mailer-daemon/.test(from) && (STOP_RX.test(t) || COMPLAINT_RX.test(t) || STOP_RX.test(ownSubj(m.subject)))) {   // r23b: no failed recipient, and the text asks to stop: a person, not a DSR
      const held = Object.values(S.P).filter(x => ['active', 'ooo', 'draft'].includes(x.status) && ((!FREEMAIL.has(d) && !MS_CONSUMER.has(d) && dom(x.email) === d) || mentionsAny(t, m.subject || '', x, S.steps[x.email]?.[0]?.subject, String(m.summary || ''))));
      for (const o of held) { setP(ctx, o, { status: 'company_paused', note: `held: opt-out wording in a bounce-looking message from ${from} (set back to active by hand if it is not them)` }); cancelSlots(ctx, o.email, 'opt-out in bounce-looking mail'); }
      if (from && !SEEDS.includes(from)) suppress(ctx, from, 'stop (unmatched thread)');
      mark('bounce_optout', t.slice(0, 200)); ctx.ev('stop', e, from, `opt-out wording in a bounce-looking message (no failed recipient): ${m.subject || ''} | ${t.slice(0, 200)}${held.length ? ' | HELD: ' + held.map(o => o.email).join(', ') : ''}`, 1);
      strangerPause(ctx, e, from, m.subject || '', t, held.map(o => o.email)); return;
    }
    if (!/mailer-daemon|postmaster/.test(from) && from) { mark('bounce_person', t.slice(0, 200)); strangerPause(ctx, e, from, m.subject || '', t, []); return; }   // r24: not a mail server: a person
    mark('bounce_unmatched', m.subject); ctx.ev('bounce_unmatched', e, null, m.subject); return; }
  for (const a of rcpts) {
    const p = S.P[a];
    if (soft && p && (p.soft_bounces || 0) < 1) { setP(ctx, p, { soft_bounces: (p.soft_bounces || 0) + 1 }); ctx.ev('soft_bounce', e, a, status || m.subject); continue; }
    suppress(ctx, a, 'hard_bounce'); if (p) { if (p.status !== 'stopped') setP(ctx, p, { status: 'bounced' }); cancelSlots(ctx, a, 'bounce'); }
    ctx.ev('hard_bounce', e, a, `status ${status || 'n/a'}`, 1);
  }
  mark(soft ? 'soft_bounce' : 'hard_bounce', rcpts.join(','));
}
const QUOTE_RX = /(\s|^)-{3,}\s*(on|em|le|am|el|il|op)\s[^\n]{4,140}?(escreveu|wrote|a écrit|schrieb|escribió|ha scritto|schreef|skrev)\s*-+|(\s|^)((em|on|le|am|el|il|op|den|dne)\s(?=[^\n]{0,15}\d)|a\s(?=\d{1,2}([\/.\-]\d{1,2}[\/.\-]\d{2,4}|\s+de\s+\S+\s+de\s+\d{4}))).{4,120}?(escreveu|wrote|a écrit|schrieb|escribió|ha scritto|schreef|skrev|napsal\w*)\s*:|<[^<>\s]+@[^<>\s]+>\s*(escreveu|wrote|a écrit|schrieb|escribió|ha scritto|schreef|skrev)|-{2,}\s*(original message|mensagem original|forwarded message|mensagem encaminhada)|_{8,}|(\s|^)(de|from|von)\s*:[^\n]{0,100}?@[^\n]{0,160}?(enviad[ao]|sent|gesendet|data|date|para|to)\s*:|(\s|^)(de|from|von)\s*:\s*\S+@|(\s|^)>(?![\s\d.,]*\d)|\n\s*owner branda\s*\n\s*branda websites/i;
const FOOTER_RX = /not relevant\?\s*reply\s*"stop"[^.\n]*\.?|reply\s*"stop"\s*and\s*i\s*won'?t\s*email\s*again[^.\n]*\.?/gi;
const ownSubj = t => String(t || '').replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, ' ').replace(/[\u2018\u2019\u201a\u201b\u2032\u02bc\uff07]/g, "'").replace(/[\u201c\u201d\u201e\u201f\u2033\uff02]/g, '"').replace(/^\s*((re|fw|fwd|enc|res|aw|sv|antw|r)\s*:\s*)+/i, '').trim();
// company confidentiality/RGPD footers and newsletter lines in a signature are not the sender speaking: own text ends where one starts
const THANKS_HOLD_RX = /\b((deixar|parar|deixo|deixem|parem) de receber|stop\w*|spam\w*|remov\w*|eras\w*|delet\w*|purg\w*|apag\w*|elimin\w*|unsubscrib\w*|block\w*|bloque\w*|not interested|leave (me|us) alone|lawyers?|attorneys?|legal action|gdpr|rgpd|cnpd|complain\w*|queix\w*|denunci\w*|advogad\w*|harass\w*|ass[ée]dio|parem?|desinscrev\w*|sem interesse|em paz)\b|\b(do not|don'?t|never|please don'?t) (e-?mail|contact|message|write|call|text)|\bno more (e-?mails|messages)|n[ãa]o (me |nos )?(envie|enviem|mande|mandem|contacte|contactem|escreva|escrevam|volte|voltem)\b|n[ãa]o (estou|estamos) interessad|n[ãa]o (tenho|temos) (qualquer )?interesse|\btake (me|us) off\b|n[ãa]o (quero|queremos|desejo|desejamos) (receber )?(mais )?(e-?mails?|mensagens|newsletters?|contactos)\b|n[ãa]o (liguem|ligue|escreva|escrevam|insista|insistam)\b|\bnem (liguem|ligue|escreva|escrevam|contacte|contactem|mande|mandem|envie|enviem)\b|\b(mailing|e-?mail) lists?\b|\bopt(ing|ed)?[- ]?(me |us )?out\b|\bsubscri\w*|\bcease\w*|\b(no|any) (further|more) (contact|communication|follow[- ]?ups?)\b|\b(do not|don'?t|no) (further )?follow[- ]?ups?\b|\b(drop|scratch|strike|cross|take) (me|us|it|this \w+) (off|from|out of)\b|\b(forget|lose) (my|our|this) (e-?mail|address|contact|number|details|data)\b|\benough (with|of)\b|\b(consent\w*|permission|unsolicited|junk|wipe|illegal\w*|ilegal\w*|proibid\w*|prohibited|data protection|ico|pecr|lgpd|anpd|procon|reclame aqui|forgotten|esquecimento|consentimento|autoriz\w*|lixo|risqu\w*)\b|\breport(ed|ing)? (this|you|it|your \w+) to\b|\bn[ãa]o solicitad\w*|\b(chega|basta) de\b|\bj[áa] (chega|basta)\b|^\W*(chega|basta)\b|\besque[çc]\w* (o |este |esse |do )?(meu |nosso |este |esse )?(e-?mail|endere[çc]o|contacto|contato|n[úu]mero)|\bperca\w* (o |os )?(meu|nosso|meus|nossos) contact|\btir(em|e|a|ar)-(me|nos)\b|\bexclu(ir|am|a|am|i|em)\b|\bexclus[ãa]o\b|\bdeix(ar|o|em|e) de (me |nos )?(enviar|mandar|receber|contactar|contatar|escrever)|\bn[ãa]o (quero|queremos) mais\b|\b(reservo|reservamos)-(me|nos) o direito\b|\b(apresent|fa[zç])\w* (uma )?(queixa|reclama)|\baviso legal\b/i;
const ownText = t => { const cutDisc = x => { const j = x.search(/(?<!\b(vou|vamos|irei|iremos|tenciono|tencionamos|pretendo|pretendemos|quero|queremos|tenho|temos|terei|teremos|decidi|decidimos|hesit\w*|j[áa]|reserv\w*|ponder\w*|equacion\w*|consider\w*)\b[^.!?\n]{0,40})\bapresentar (uma )?(reclama[çc][ãa]o|queixa)( formal)? (à|a|na|junto da|perante a) (cnpd|comiss[ãa]o nacional|autoridade de controlo)(?![^.\n]{0,80}\?)|(em cumprimento|nos termos|ao abrigo)( d[oa])? (rgpd|regulamento geral|regulamento \(ue\))(?![^.]{0,80}\b(venho|solicito|solicitamos|exer[çc]o|exercemos|pe[çc]o|pedimos|requeiro|requeremos|invoco|exijo|exigimos|quero|queremos)\b)[^.]{0,120}?\b(informa\w* que (pode|podem|poder[áa]|tem|t[êe]m|o titular|os (seus )?dados)|titular\w*|os direitos de|o direito de (acesso|retifica|oposi|apagamento|elimina)|os (seus )?dados( pessoais)?( recolhidos| fornecidos)? (s[ãa]o|ser[ãa]o|foram|destinam))|(caso|se) consider\w* que o tratamento|os (seus )?dados( pessoais)?( [^\s.]+){1,2} (s[ãa]o|ser[ãa]o) (tratados|utilizados|processados)|aviso (legal|de confidencialidade)|confidencialidade\s*:|confidentiality (notice|note|statement)|disclaimer\s*:|privacy notice\s*:|esta (mensagem|comunica[çc][ãa]o)( de correio eletr[óo]nico| eletr[óo]nica)?( e (os seus|quaisquer|eventuais|respetivos|respectivos) (anexos|ficheiros)( anexos)?)? (é|são|e|sao|pode conter|cont[ée]m)[^.]{0,40}confidencia|this (e-?mail|message|communication)( and any (attachments|files)[^.]{0,30})? (is|are|may contain|contains)[^.]{0,40}confidential|informa[çc][ãa]o confidencial\s*[.:!\n-]|strictly prohibited|(é|e) (estritamente |expressamente )?proibid[ao] (a|o|qualquer) (sua )?(divulga|c[óo]pia|reprodu|utiliza|distribui)|destina(m)?-se exclusivamente|se recebeu (esta|este) (mensagem|e-?mail) por (engano|erro)|if you (are not the intended|have received this (e-?mail|message) in error)|os (seus )?dados pessoais (são|ser[ãa]o) tratados|(tem|têm|pode|podem|poder[áa])( ainda| também| sempre| igualmente)? (o )?direito (de|a) (apresentar )?(uma )?(queixa|reclama)(?![^.\n]{0,80}\?)|(pode|podem|poder[áa]) (ainda |também |igualmente |sempre )?apresentar (uma )?(queixa|reclama[çc][ãa]o) (junto d|(à|a|na|perante a) (cnpd|comiss[ãa]o nacional|autoridade de controlo))|assiste-(lhe|vos|lhes)\b|(divulga[çc][ãa]o|c[óo]pia|reprodu[çc][ãa]o|utiliza[çc][ãa]o|distribui[çc][ãa]o)( ou (divulga|c[óo]pia|reprodu|utiliza|distribui)\S*)? (n[ãa]o autorizad[ao]|indevid[ao]) (desta|deste|da presente|do presente) (mensagem|e-?mail|comunica)|(para|caso|se) (deixar de|n[ãa]o (pretend\w*|desej\w*|quiser)( continuar a)?) receber (a nossa|as nossas|os nossos|mais) (newsletter|comunica|e-?mails|campanhas|informa)(?![\wÀ-ɏ]*\s+(seus|vossos|teus|de voc[êe]s|de si|da (vossa|sua) parte)\b)(?![^.\n]{0,80}\?)|to unsubscribe from (our|this) (newsletter|mailing)(?![^.\n]{0,80}\?)|invitation from google calendar|convite do google (calendar|agenda)|you are receiving this (e-?mail|invitation|notification)( at the account \S+)? because|est[áa] a receber este e-?mail porque|voc[êe] est[áa] recebendo este e-?mail porque|to stop receiving (future )?updates for this event|para (deixar de|parar de|n[ãa]o) receber (mais )?atualiza[çc][õo]es deste evento/i); return j < 0 ? x : x.slice(0, j); }; const s = String(t || '').replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, ' ').replace(/[\u2018\u2019\u201a\u201b\u2032\u02bc\uff07]/g, "'").replace(/[\u201c\u201d\u201e\u201f\u2033\uff02]/g, '"').replace(/\bnaõ(?![\wÀ-ɏ])/gi, 'não').replace(FOOTER_RX, ' '); const i = s.search(QUOTE_RX); let o = cutDisc(i < 0 ? s : s.slice(0, i)); for (let k = 0; k < 2; k++) o = o.replace(/\s*(\balex operator|enviado d[eo] (meu|minha) [^\n.]{1,30}\.?|sent from my [^\n.]{1,30}\.?|obter o outlook para \S+|get outlook for \S+)\s*$/i, ''); return o.trim() ? o : cutDisc(s); };   // Gmail pt-PT puts our display name before "<addr> escreveu (...)"; phone signatures sit above the quote
const ownHold = t => { const s = String(t || '').replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, ' ').replace(/[\u2018\u2019\u201a\u201b\u2032\u02bc\uff07]/g, "'").replace(/\bnaõ(?![\wÀ-ɏ])/gi, 'não').replace(FOOTER_RX, ' '); const i = s.search(QUOTE_RX), o = i < 0 ? s : s.slice(0, i); return o.trim() ? o : s; };   // the reply up to the quote, before the disclaimer cut: for the warm thanks hold only
// an auto-reply that asks for this address to be dropped ("I no longer work here, please remove this address from your list") is an opt-out, not an OOO
const AUTO_FOOT_RX = /(to|para) (unsubscribe|cancelar (a )?subscri[çc][ãa]o)[^.\n]{0,60}\b(notifica[\wçõã]*|notifications?|alerts?|updates?|tickets?)\b[^.\n]*|(^|[\n|.!]\s*)(unsubscribe|cancelar (a )?subscri[çc][ãa]o|manage (preferences|notifications)|prefer[êe]ncias)\s*(?=\||$)/gim;   // a helpdesk / newsletter footer in an auto-reply is not the mailbox asking to stop
const AUTO_STOP_RX = /\bremove (this|my|the|our) (e-?mail )?(address|e-?mail|mailbox|contact)|\btake (it|this( e-?mail)?( address)?|me|us) off\b|\b(do not|don'?t) (e-?mail|send( \w+)? to|write to|contact|use) this (e-?mail )?(address|mailbox)|\b(do not|don'?t) send (any ?more|anything (else|further))|\bno longer (monitored|in use)[^.\n]{0,60}\b(remove|delete|update|take)\b|\bno longer (monitored|in use|active|valid|used|being monitored)\b[^\n]{0,100}?\b((remove|delete|take) (it|this|me|us|my|our|the)\b|update (your|the) (records|list|contacts?|contact (list|details)|details|database|address book|mailing list|distribution list|crm))|\bremove (it|us|me) from (your|the|all) (list|lists|mailing|distribution|contacts?|database|records|records|system|crm)\b|\bj[áa] n[ãa]o (est[áa]|se encontra|é|e) (em uso|ativ[oa]|activ[oa]|monitorizad[oa]|utilizad[oa]|v[áa]lid[oa])\b[^\n]{0,100}?\b((remov|retir|apag|elimin|exclu)\w*|atualiz\w* (os (seus|vossos) (contactos|registos|dados)|a (sua|vossa) (lista|base de dados)))|(?<!\bn[ãa]o\s(\S+\s)?)\b(retir|remov|exclu)(em|am|e|a|ar|er|ir)\s+((por favor|favor|pf)\s+)?(este|esse|o meu|o nosso|meu|nosso|o)\s+(e-?mail|endere[çc]o|contacto|contato|caixa)\b|(?<!\bn[ãa]o\s(\S+\s)?)\b(apag|elimin)(em|am|e|a|ar|ue|uem)\s+((por favor|favor|pf)\s+)?(este|esse|o meu|o nosso|meu|nosso|o)\s+(endere[çc]o|contacto|contato)\b|\b(retir|remov|exclu)(em|am|e|a|ar|er|ir|ê|á|i)?-(o|a|no|na|lo|la)\b(?=\s*(d[aeo]s?\s+((vossa|vossas|sua|suas|vosso|vossos|seu|seus)\s+)?(lista|listas|base|mailing|contactos|contatos|registos|registros|cadastro|agenda|sistema)|[.!,;]|$|por favor|obrigad))|\b(apag|elimin)(em|am|e|a|ar|ue|uem)?-(o|a|no|na|lo|la)\s+d[aeo]s?\s+((vossa|vossas|sua|suas|vosso|vossos|seu|seus)\s+)?(lista|listas|base|mailing|contactos|contatos|registos|registros|cadastro|sistema)\b|\b(remo[çc][ãa]o|exclus[ãa]o|elimina[çc][ãa]o|retirada)\s+d(este|esse|o meu|o nosso|o)\s+(e-?mail|endere[çc]o|contacto|contato)\b|(?<!\bn[ãa]o\s)\bdeix\w* de (usar|utilizar|enviar para|escrever para) (este|esse) (e-?mail|endere[çc]o|contacto|contato|caixa)|(\b(deixei de trabalhar|sa[íi] d[ao]s?|j[áa] n[ãa]o (trabalho|fa[çc]o parte|estou)|n[ãa]o (trabalho|fa[çc]o parte) mais|n[ãa]o (trabalho|fa[çc]o) mais (aqui|parte|n[ae]s?)\b|reformei-me|me reformei|me aposentei|aposentei-me|me desliguei)|\b(e-?mail|endere[çc]o|caixa|conta|correio)\b[^.\n]{0,40}?\b(j[áa] n[ãa]o (é|e|est[áa]|se encontra) (lid|usad|utilizad|consultad|monitorizad|monitorad|ativ|activ|v[áa]lid)[oa]|n[ãa]o (é|e|est[áa]) mais (lid|usad|utilizad|consultad|monitorad|monitorizad|ativ|v[áa]lid)[oa]|(foi|est[áa]|ser[áa]|encontra-se) (desativad|desactivad|encerrad|eliminad|desligad|cancelad|inativad|inactivad|descontinuad)[oa]|deixou de (existir|funcionar|estar ativ[oa]|ser (lid|usad|utilizad|monitorizad)[oa])|n[ãa]o existe mais|j[áa] n[ãa]o existe))[^]{0,160}?\b(atualiz|actualiz)\w*\s+((a|o|os|as)\s+)?(vossa|vossas|sua|suas|seu|seus|vosso|vossos)\s+(lista|listas|base|contactos|contatos|registos|registros|cadastro|dados|agenda|mailing)|\b(do not|don'?t) send (any )?(further|more|additional) (e-?mails?|messages|mail|correspondence)\b(?![^.\n]{0,60}\b(until|before|while|during|till)\b)|\b(do not|don'?t) send (e-?mails?|messages|mail) (here|to (this|the|my) (e-?mail )?(address|mailbox|account|inbox))\b(?![^.\n]{0,40}\b(until|before|while|during|urgent)\b)|\bno further (e-?mails?|messages|mail|correspondence)\b(?=\s*(to (this|the|my)\b|please\b|thanks?\b|[.!,;]|$))(?![^.\n]{0,60}\b(until|before|while|during|till)\b)|\bcease (all |any )?(further )?(e-?mails?|e-?mailing|messages|mail|communications?|contact|correspondence|sending)\b|\b(delete|erase|purge) (this|the|my|our) (e-?mail )?(address|mailbox|account|contact)\b|\bremove (it |this( e-?mail)?( address)? )?from (your|the|all) (list|lists|mailing|distribution|contacts?|database|records|system|crm|address book)\b|\b(remov|retir|elimin|apag|exclu|descadastr)\w*\b[^.\n;,]{0,30}?\b(d[aeo]s?|from)\s+((vossa|vossas|sua|suas|seu|seus|vosso|vossos|your)\s+(mailing( list)?|lista|cadastro|base de dados|contactos|contatos|registos|registros)|(the\s+)?(mailing( list)?|lista( de (envio|distribui[çc][ãa]o|e-?mails?))?|cadastro|base de dados))\b|\bn[ãa]o (recebemos|aceitamos|aceito|pretendemos receber|queremos receber) (publicidade|propaganda|marketing|spam|comunica[çc][õo]es (comerciais|de marketing)|e-?mails? (comerciais|de (marketing|publicidade|prospe[cç][çc][ãa]o)))\b|\bn[ãa]o (envie|enviem|mande|mandem) (publicidade|propaganda|marketing|propostas comerciais)\b|\bdiscontinue (sending|e-?mailing|all (e-?mails?|correspondence)|any (further )?(e-?mails?|correspondence))\b|\b(do not|don'?t) send (us |me )?(any )?(further |more )?(marketing|sales|promotional|advertising|solicitations?|cold) ?(e-?mails?|messages|offers|material|mail)?\b(?![^.\n]{0,60}\b(until|before|while|during|till)\b)|\b(retirer|supprimer|effacer|radier|d[ée]sinscrire|d[ée]sabonner|enlever)\b[^.\n]{0,40}?\b(adresse|liste|fichier|base|contacts?|mailing|diffusion)\b|\bne plus (m'|nous |me |l'|leur )?(envoyer|[ée]crire|contacter|solliciter|adresser)\b|\bne plus (utiliser|employer) cette adresse\b|\bne (souhait|d[ée]sir|veu)\w* (pas|plus) recevoir\b|\b(elimin|b[oó]rr|qu[ií]t|retir|suprim|s[aá]qu)(e|en)(nos|me|la|lo)?\b[^.\n;,]{0,40}?\b(direcci[óo]n|lista|base de datos|contactos?|env[íi]os)\b|\bd[ée](nos|me)(la|lo)? de baja\b|\bdar(nos|me|la|lo)? de baja\b|\bde baja de (su|la|sus) (lista|base|env[íi]os)|\bno (nos |me )?(env[íi]e|env[íi]en|escriba|escriban|contacte|contacten|mande|manden)\w* (m[áa]s (correos|e-?mails?|mensajes|publicidad|ofertas)|m[áa]s\s*([.!]|$)|ning[úu]n (otro )?(correo|e-?mail|mensaje)|correos? (comerciales|publicitarios))|\bno (deseamos|queremos|deseo|quiero) recibir (publicidad|correos|m[áa]s|ofertas|comunicaciones)\b|\bno (nos |me )?(env[íi]e|env[íi]en|mande|manden) (m[áa]s )?correos (comerciales|publicitarios|de marketing)/i;
const AUTO_CMP_RX = /^\W*spam\b|\b(isto|this|it) (é|e|is) spam\b|\bspam\W+(reported|denunciad\w*)|\bn[ãa]o (autoriz(ámos|amos|ei|ou|aram)|demos autoriza[çc][ãa]o)\b|\b(did|do) not (authori[sz]e|consent to)\b/i;
const AUTO_SUBJ_RX = /^(automatic reply|auto.?reply|autoreply|out of (the )?office|ooo\b|away from|on vacation|autosvar|abwesenheit|r[ée]ponse automatique|fr[åa]nvaro|poissa|automaattinen vastaus|automatikus v[áa]lasz|automatick[áa] odpov[eě]\S*|frav[æa]r|automaatvastus|samodejni odgovor|absence|absent du bureau|resposta autom[áa]tica|ausente|aus[êe]ncia|fora do escrit[óo]rio|respuesta autom[áa]tica|fuera de la oficina|risposta automatica|fuori ufficio|fuori sede|assente|f[ée]rias|vacaciones|vacances|urlaub)/i;
const autoHdr = H => (H['auto-submitted'] && !/^no\b/i.test(H['auto-submitted'])) || H['x-autoreply'] || H['x-autorespond'] || /auto[_-]?reply/i.test(H['precedence'] || '');
const htmlText = h => unent(h.replace(/<(style|script|head)[^]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d|blockquote)>/gi, '\n').replace(/<blockquote/gi, '\n> <blockquote').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ');
const deacc = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const mentionsDom = (t, email) => { const d = dom(email); if (!d || FREEMAIL.has(d) || MS_CONSUMER.has(d)) return false; return new RegExp('(^|[^a-z0-9.@-])(www\\.)?' + d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9-])').test(String(t).toLowerCase()); };
const mentionsCo = (t, co) => { const c = deacc(co).replace(/[^a-z0-9& ]+/g, ' ').replace(/\b(lda|unipessoal|sa|ltda|ltd|limitada)\b/g, ' ').replace(/\s+/g, ' ').trim(); if (c.length < 6 || !/\s/.test(c)) return false; return (' ' + deacc(t).replace(/[^a-z0-9& ]+/g, ' ').replace(/\s+/g, ' ') + ' ').includes(' ' + c + ' '); };
// r23b: more ways an unmatched message identifies a prospect's business: the website without its TLD or under another TLD, an Instagram/social handle,
// the website of a freemail prospect (source_url), a one-word or legal/trade variant of the company name, our own subject inside theirs (RV:/TR:/WG:/[#123]/"- parem"),
// or a forwarded / quoted copy of our email whose header names the prospect address or our subject
const CO_GENERIC = new Set('clinica clinicas dentaria dental medica medico hotel hoteis hostel guesthouse residencial alojamento restaurante cafe cafetaria pastelaria padaria barbearia cabeleireiro cabeleireiros salao studio estudio loja oficina auto imobiliaria escola academia ginasio farmacia bar snack tasca taberna spa beauty centro grupo consultorio atelier agencia advogados sociedade the company group shop store'.split(' '));
const CO_STOPW = new Set('de da do das dos e and of the a o & lda unipessoal sa ltda ltd limitada'.split(' '));
const SOCIAL_HOST_RX = /(^|\.)(facebook|fb|instagram|linktr|google|goo|tripadvisor|booking|airbnb|yelp|zomato|thefork|linkedin|youtube|tiktok|twitter|x|sapo|wix|wordpress|blogspot|negocio|cylex|paginasamarelas)\.[a-z.]+$/;
const hostOf = u => { try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(String(u)) ? String(u) : 'https://' + String(u).trim()).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const mentionsWeb = (t, x) => {
  const labs = new Set(), d = dom(x.email), hs = hostOf(x.source_url);
  if (d && !FREEMAIL.has(d) && !MS_CONSUMER.has(d)) labs.add(d.split('.')[0]);
  if (hs && !SOCIAL_HOST_RX.test(hs)) { labs.add(hs.split('.')[0]); if (new RegExp('(^|[^a-z0-9.@-])(www\\.)?' + hs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9-])').test(String(t).toLowerCase())) return true; }
  const coL = deacc(x.company || '').replace(/\b(lda|unipessoal|sa|ltda|ltd|limitada)\b/g, ' ').replace(/[^a-z0-9]+/g, '');
  const L = [...labs].map(l => l.replace(/-/g, '')).filter(l => l.length >= 6 && !CO_GENERIC.has(l));
  if (coL.length >= 8) L.push(coL);
  if (!L.length) return false;
  for (const w of deacc(t).match(/[a-z0-9][a-z0-9._-]*[a-z0-9]/g) || []) { const a = w.replace(/^www\./, ''), b = a.split('.')[0].replace(/-/g, ''), c = a.replace(/[._-]/g, ''); if (L.includes(b) || L.includes(c)) return true; }
  return false; };
const STREET_W = new Set('rua r av avenida avda travessa tv trav largo lgo praca pc pca estrada estr alameda al calcada cc beco rotunda urbanizacao urb bairro edificio edif lote street st avenue ave road rd lane square'.split(' '));
const ADDR_LINK = new Set('d dom dona de da do das dos dr dra eng prof sao santo santa nossa senhora infante general almirante marques conde duque rei rainha the of'.split(' '));
const mentionsCoTok = (t, co) => {   // the distinctive words of the company in order (generic words like "clínica" / legal suffixes dropped)
  const toks = deacc(co).replace(/[^a-z0-9& ]+/g, ' ').split(/\s+/).filter(w => w && !['lda', 'unipessoal', 'sa', 'ltda', 'ltd', 'limitada'].includes(w));
  const dist = toks.filter(w => !CO_GENERIC.has(w) && !CO_STOPW.has(w)), gen = toks.filter(w => CO_GENERIC.has(w));
  if (!dist.length || dist.join('').length < 5) return false;
  const T = deacc(t).replace(/[^a-z0-9& ]+/g, ' ').split(/\s+/).filter(Boolean);
  // r24a: words that follow a street word are an address, not the business ("Avenida Dom João II" in a signature is not Residencial Dom João)
  const addr = i => { for (let j = i - 1; j >= Math.max(0, i - 3); j--) { if (STREET_W.has(T[j])) return true; if (!ADDR_LINK.has(T[j])) return false; } return false; };
  if (toks.length === 1) return dist[0].length >= 5 && T.some((w, i) => w === dist[0] && !addr(i));
  for (let i = 0; i < T.length; i++) { if (T[i] !== dist[0] || addr(i)) continue; let k = i, ok = true;
    for (const w of dist.slice(1)) { let f = -1; for (let j = k + 1; j <= k + 3 && j < T.length; j++) if (T[j] === w) { f = j; break; } if (f < 0) { ok = false; break; } k = f; }
    if (!ok) continue; if (dist.length >= 2) return true;
    for (let j = Math.max(0, i - 3); j <= Math.min(T.length - 1, i + 3); j++) if (gen.includes(T[j])) return true; }
  return false; };
const mentionsSubj = (subj, raw, s0) => { const z = lc(ownSubj(s0 || '')); if (z.length < 8) return false; if (lc(ownSubj(subj)).includes(z)) return true;
  const q = String(raw || ''), k = q.search(QUOTE_RX); return k >= 0 && lc(q.slice(k)).includes(z); };
// r24b: strict = the address, domain, website/handle, exact company name, all distinctive words of a 2+ word name side by side, a one-word name, or
// the prospect address in a quoted copy. A tie only on a near name (words with a gap, one distinctive word next to a generic one) or on a shared subject is weak.
const coTokStrict = (t, co) => { const toks = deacc(co).replace(/[^a-z0-9& ]+/g, ' ').split(/\s+/).filter(w => w && !['lda', 'unipessoal', 'sa', 'ltda', 'ltd', 'limitada'].includes(w));
  const dist = toks.filter(w => !CO_GENERIC.has(w) && !CO_STOPW.has(w)); if (toks.length === 1) return mentionsCoTok(t, co); if (dist.length < 2) return false;
  return (' ' + deacc(t).replace(/[^a-z0-9& ]+/g, ' ').replace(/\s+/g, ' ') + ' ').includes(' ' + dist.join(' ') + ' '); };
const mentionsAny = (own, subj, x, s0 = x.subject, raw = '', strict = false) => { const t = own + '\n' + ownSubj(subj), q = String(raw || ''), k = q.search(QUOTE_RX);
  return mentionsDom(t, x.email) || mentionsCo(t, x.company) || mentionsWeb(t, x) || (strict ? coTokStrict(t, x.company || '') : mentionsCoTok(t, x.company || '') || mentionsSubj(subj, raw, s0)) || (k >= 0 && lc(q.slice(k)).includes(lc(x.email))); };
// r24b: a weak tie may be the wrong business ("Casa Flor do Mar" ties "Casa do Mar", "Clínica Sorriso Feliz" ties "Clínica Dentária Sorriso"): every prospect sharing a
// distinctive name word (singular/plural folded) is a candidate and is held too
const stemW = w => w.length > 5 && /[^aeiou]es$/.test(w) ? w.slice(0, -2) : w.length > 4 && /s$/.test(w) ? w.slice(0, -1) : w;
const coShare = (t, co) => { const T = new Set(deacc(t).replace(/[^a-z0-9& ]+/g, ' ').split(/\s+/).filter(Boolean).map(stemW));
  return deacc(co).replace(/[^a-z0-9& ]+/g, ' ').split(/\s+/).filter(w => w.length >= 4 && !CO_GENERIC.has(w) && !CO_STOPW.has(w)).some(w => T.has(stemW(w))); };
// r24b: stop wording a person wrote, not a mailing footer ("para deixar de receber clique aqui", "unsubscribe"): used where a bulk header or the Spam folder would otherwise silence it
const FOOTSENT_RX = /unsubscri|subscri[cçp]|deixar de receber|clique|click|\blink\b|prefer[eê]nc|newsletter|\baqui\b|\bhere\b|(recebeu|received) (este|this)|this (e-?mail|message) was sent|mailing preferences/i;
const humanStop = (own, subj) => STOP_RX.test(String(own || '').split(/(?<=[.!?\n])\s*/).filter(x => !FOOTSENT_RX.test(x)).join(' ')) || (STOP_RX.test(ownSubj(subj)) && !FOOTSENT_RX.test(subj || ''));
const isFree = d => FREEMAIL.has(d) || MS_CONSUMER.has(d);   // used by tests/r24b_gen.mjs
async function onReply(ctx, b, m, p, mark, etDay) {
  const S = ctx.S, e = b.email, from = lc(m.fromAddress), subj = m.subject || '';
  let summ = ownText(m.summary || ''), hold = ownHold(m.summary || '');
  let H = {}; try { const r = await zapi(ctx, e, 'GET', `/accounts/${aidOf(ctx, e)}/folders/${m.folderId}/messages/${m.messageId}/header?raw=false`); H = headerMap(r.d); } catch (err) { if (err instanceof Budget) throw err; }
  const auto = autoHdr(H) || AUTO_SUBJ_RX.test(subj);
  // the listing summary is a preview: a long one with no quote header in it may be cut before the part that decides (a "... how much?" after a scoped "not interested", or a stop at the end), so read the whole message
  if (String(m.summary || '').length >= 100 && String(m.summary).search(QUOTE_RX) < 0) {
    try { const c = await zapi(ctx, e, 'GET', `/accounts/${aidOf(ctx, e)}/folders/${m.folderId}/messages/${m.messageId}/content`); let h = c.s === 200 && c.d && c.d.data && typeof c.d.data.content === 'string' ? c.d.data.content : '';
      { const k = h.search(/<(div|span|table)\b[^>]*\b(class=["']?[^"'>]*\bgmail_signature\b|id=["']?(Signature|ms-outlook-mobile-signature)\b)/i); if (k > 0 && h.slice(0, k).replace(/<[^>]+>|&nbsp;|\s/gi, '').length) h = h.slice(0, k); }   // the sender's signature block (and the company RGPD/confidentiality footer in it) is not the sender speaking
      if (h.trim()) { const ht = unent(h.replace(/<(style|script|head)[^]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d|blockquote)>/gi, '\n').replace(/<blockquote/gi, '\n> <blockquote').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' '); summ = ownText(ht); hold = ownHold(ht); }
    } catch (err) { if (err instanceof Budget) throw err; }
  }
  // an auto-reply is an OOO unless it asks to be removed ("I no longer work here, please remove me from your list"): that is an opt-out (a stop, never a complaint / KILL)
  const af0 = summ.replace(AUTO_FOOT_RX, ' '), af = af0.trim() ? af0 : summ, autoStop = auto && (STOP_RX.test(af) || AUTO_STOP_RX.test(af));
  if (auto && !autoStop && (COMPLAINT_RX.test(af) || AUTO_CMP_RX.test(af))) {   // r23b: complaint wording under an auto flag (a helpdesk agent reply, a typed "Resposta automática" subject) is never a silent OOO that resumes
    if (['active', 'sent_awaiting', 'ooo'].includes(p.status)) setP(ctx, p, { status: 'company_paused', note: `held: auto-flagged message from ${from} with complaint wording (set back to active by hand if it is a plain out-of-office)` });
    cancelSlots(ctx, p.email, 'auto complaint hold'); mark('auto_complaint_hold', summ.slice(0, 200)); ctx.ev('reply', e, from, `HELD (auto-flagged, reads like a complaint: check it, stop it by hand if it is one): ${subj} | ${summ.slice(0, 300)} | reply id ${m.messageId}`, 1); return;
  }
  if (auto && !autoStop) {
    const back = parseReturn(summ, etDay) || addBusinessDays(etDay, 7);
    if (['active', 'sent_awaiting'].includes(p.status)) setP(ctx, p, { status: p.status === 'active' ? 'active' : p.status, resume_date: back });
    cancelSlots(ctx, p.email, 'ooo'); mark('ooo', back); ctx.ev('ooo', e, p.email, `resume ${back}`); return;
  }
  const sj = ownSubj(subj), sjOurs = lc(sj) === lc(S.steps[p.email]?.[0]?.subject || '');
  if (!autoStop && (COMPLAINT_RX.test(summ) || (!sjOurs && COMPLAINT_RX.test(sj)))) {
    suppress(ctx, p.email, 'complaint'); suppress(ctx, from, 'complaint'); setP(ctx, p, { status: 'stopped' }); cancelSlots(ctx, p.email, 'complaint');
    const also = companyHold(ctx, p, from, 'complaint'), n7 = complaintCount7(ctx, from);
    mark('complaint', dsrTag(summ) + summ.slice(0, 200)); ctx.ev('complaint', e, from, dsrTag(summ) + summ.slice(0, 300) + also + (n7 >= killN(S) ? '' : ' | first complaint in 7 days: sending CONTINUES for other companies (seqadmin kill {"on":true} to stop everything); a second one stops all sending'), 1);
    if (n7 >= killN(S)) { ctx.kv('kill', (`auto: complaint from ${from} (${n7} complaints in 7 days)` + (/^auto: hold:/.test(String(S.kv.kill || '')) ? ' | ' + S.kv.kill : '')).slice(0, 1500)); ctx.ev('kill', null, null, `global stop: ${n7} complaints in 7 days`, 1); }
    if (p.lane === 'brandb' && !laneHeld(S.kv, 'brandb')) { ctx.kv('kill_brandb', `auto: complaint from ${from}`); ctx.ev('lane_hold', e, from, `BRANDB COLD HELD: a complaint from an attorney (${from}). BrandA continues. Read it, then re-arm with seqadmin kill {"lane":"brandb","on":false,"force":true}`, 1); }
    return;
  }
  if (autoStop || STOP_RX.test(summ) || (!sjOurs && STOP_RX.test(sj))) {
    suppress(ctx, p.email, 'stop'); if (from !== p.email) suppress(ctx, from, 'stop'); setP(ctx, p, { status: 'stopped' }); cancelSlots(ctx, p.email, 'stop');
    // "stop" from a person speaks for the company: nobody else there gets emailed again. An auto-reply that asks for THIS address to be dropped
    // ("no longer monitored, please contact maria@ instead") is the mailbox, not the company: the address is dropped, colleagues are not stopped.
    const also = autoStop ? ' | auto-reply asking to drop this address: colleagues and the company domain NOT stopped (stop them by hand if it reads as a company opt-out)' : companyHold(ctx, p, from, 'stop');

    mark('stop', dsrTag(summ) + summ.slice(0, 200)); ctx.ev('stop', e, from, dsrTag(summ) + summ.slice(0, 200) + also, 1); return;
  }
  if (p.status === 'stopped') {   // an opt-out who writes again ("ok, thanks") stays opted out: no status change (EU rows are still erased at rollover), no thanks, no colleague pause; the operator is told
    mark('reply', dsrTag(summ) + summ.slice(0, 300)); ctx.ev('reply', e, from, `${dsrTag(summ)}ALREADY OPTED OUT, do not email${dsrTag(summ) ? ' (except the answer to this request: /admin/reply force:true)' : ''}: ${subj} | ${summ.slice(0, 400)} | reply id ${m.messageId}`, 1); return;
  }
  // human reply: end every sequence to this person, pause colleagues while the conversation is live
  setP(ctx, p, { status: 'replied', last_inbound_mid: String(m.messageId) }); cancelSlots(ctx, p.email, 'replied');
  if (p.company) for (const o of Object.values(S.P)) if (o !== p && o.company === p.company && o.status === 'active') setP(ctx, o, { status: 'company_paused', note: 'colleague replied: ' + p.email });
  mark('reply', dsrTag(summ) + summ.slice(0, 300));
  if (p.lane === 'warm') {
    const already = S.slots.some(s => s.kind === 'thanks' && s.email === p.email) || (await ctx.db.prepare('SELECT 1 FROM attempts WHERE key=?').bind('thanks|' + p.email).first());
    const held = THANKS_HOLD_RX.test(summ) || DSR_RX.test(summ) || !summ.trim() || THANKS_HOLD_RX.test(hold) || DSR_RX.test(hold);   // an opt-out the classifier missed, or a data request (the operator answers it), must not get an automated email back
    const autoThanks = S.kv.warm_thanks === 'on';   // round 20: the automated warm thanks is OFF unless the operator turns it on (kv warm_thanks=on). Every missed opt-out wording was a path to an automated email; with it off, a warm reply never gets an automated answer and the operator replies by hand.
    if (!already && !held && autoThanks) {
      const due = thanksTime(ctx, p);
      const ins = await ctx.db.prepare('INSERT INTO slots(et_day,box,email,step,kind,due_at,status,ref) VALUES(?,?,?,?,?,?,?,?) RETURNING id').bind(dayIn(ET, due), e, p.email, 0, 'thanks', due, 'pending', String(m.messageId)).first();
      S.slots.push({ id: ins.id, et_day: dayIn(ET, due), box: e, email: p.email, step: 0, kind: 'thanks', due_at: due, status: 'pending', ref: String(m.messageId) });
    }
    ctx.ev('warm_reply', e, from, `${!autoThanks && !held ? 'WARM REPLY (answer by hand; automated thanks is off): ' : ''}${held ? (THANKS_HOLD_RX.test(summ) || THANKS_HOLD_RX.test(hold) ? 'NO THANKS SENT (reads like an opt-out or complaint: check it, stop it by hand if it is one): ' : 'NO THANKS SENT: ') : ''}${dsrTag(summ)}${subj} | ${summ.slice(0, 200)}`, held || !autoThanks || dsrTag(summ) ? 1 : 0);
  } else { const who = [p.company, from !== p.email ? 'thread ' + p.email : ''].filter(Boolean).join(', '); ctx.ev('reply', e, from, `${dsrTag(summ)}${who ? who + ' | ' : ''}${subj} | ${summ.slice(0, 400)} | reply id ${m.messageId}`, 1); }   // cold reply: the operator answers; Claude sends it with /admin/reply {mid}
}
// The company behind a stop/complaint: its (non-freemail) domains, its company name, and every colleague already enrolled.
// Each is written to the suppression table, because prospect rows of EU opt-outs are erased at the next rollover:
// a stop kept only as prospects.status='stopped' would be forgotten and the address could be enrolled and emailed again.
function companyStop(ctx, p, from, kind) {
  const S = ctx.S, isFree = d => FREEMAIL.has(d) || MS_CONSUMER.has(d), out = [];
  const cdoms = [...new Set([dom(from), dom(p.email)].filter(d => !isFree(d)))];   // a freemail domain (gmail.com) is never a company
  for (const d of cdoms) suppress(ctx, '@' + d, kind + ' (company)');
  if (p.company) suppress(ctx, 'co:' + lc(p.company), kind + ' (company name)');   // checked at enrol: a new address for this company is refused
  for (const o of Object.values(S.P)) if (o !== p && (cdoms.includes(dom(o.email)) || (p.company && o.company === p.company)) && ['active', 'company_paused', 'ooo', 'draft'].includes(o.status)) {
    setP(ctx, o, { status: 'stopped', note: 'company asked to stop: ' + from }); cancelSlots(ctx, o.email, 'company stop'); suppress(ctx, o.email, kind + ' (company)'); out.push(o.email);
  }
  return out.length ? ` | also stopped (same company): ${out.join(', ')}` : '';
}
// Round 22 (the operator, 23 Oct 2026: "make misreads harmless"): a reply read as a stop or complaint never blocks a whole company, erases data or stops all
// sending on its own. The person is stopped at once (no more automated email to them); colleagues are held (company_paused); the company-wide block is
// applied after PENDING_DAYS unless the operator runs /admin/undo, or at once with /admin/confirm. Erasure of an EU opt-out waits the same 3 days (rollover).
// One complaint holds that company and alerts; a second complaint (another sender) within 7 days stops all sending, as before.
const PENDING_DAYS = 3, pendDays = S => (S.kv.pending_days != null && S.kv.pending_days !== '' ? +S.kv.pending_days : PENDING_DAYS), killN = S => +(S.kv.complaint_kill_n || 2);   // kv overrides exist for the offline harness (legacy suites run with 0 days / 1 complaint); production has neither key
function companyHold(ctx, p, from, kind) {
  const S = ctx.S, isFree = d => FREEMAIL.has(d) || MS_CONSUMER.has(d), out = [];
  const cdoms = [...new Set([dom(from), dom(p.email)].filter(d => !isFree(d)))];
  for (const o of Object.values(S.P)) if (o !== p && (cdoms.includes(dom(o.email)) || (p.company && o.company === p.company)) && ['active', 'company_paused', 'ooo', 'draft'].includes(o.status)) {
    setP(ctx, o, { status: 'company_paused', note: `held: ${kind} from ${from} (company stop pending; was ${o.status})` }); cancelSlots(ctx, o.email, 'company hold'); out.push(o.email);
  }
  const due = ctx.now + pendDays(S) * DAY;
  ctx.kv('pend:' + lc(p.email), JSON.stringify({ email: lc(p.email), company: p.company || null, from: lc(from), kind, at: ctx.now, due }));
  const when = new Date(due).toISOString().slice(0, 10);
  return ` | company HELD, not blocked: ${out.length ? out.join(', ') + ' paused; ' : ''}company-wide stop applies on ${when} unless you undo it (seqadmin undo {"email":"${lc(p.email)}"}), or now with seqadmin confirm {"email":"${lc(p.email)}"}`;
}
function applyPending(ctx, only = null) {   // company stops whose 3-day wait is over (or confirmed by the operator)
  const S = ctx.S, done = [];
  for (const [k, v] of Object.entries(S.kv)) {
    if (!k.startsWith('pend:')) continue;
    let x; try { x = JSON.parse(v); } catch { x = null; }
    if (!x || !x.email) { ctx.q('DELETE FROM kv WHERE k=?', k); delete S.kv[k]; continue; }
    if (only ? x.email !== only : ctx.now < x.due) continue;
    const pp = S.P[x.email] || { email: x.email, company: x.company };
    const also = companyStop(ctx, pp, x.from || x.email, x.kind || 'stop');
    if (only) ctx.q("UPDATE suppression SET at=? WHERE email IN (?,?) AND until IS NULL AND (reason LIKE 'stop%' OR reason LIKE 'complaint%') AND at > ?", new Date(ctx.now - pendDays(S) * DAY - 1000).toISOString(), x.email, x.from || x.email, new Date(ctx.now - pendDays(S) * DAY).toISOString());   // round 22a: confirmed by the operator = the undo window is over: erased at the next rollover
    for (const o of Object.values(S.P)) if (o.status === 'company_paused' && String(o.note || '').startsWith(`held: ${x.kind} from ${x.from}`)) { setP(ctx, o, { status: 'stopped', note: 'company asked to stop: ' + x.from }); suppress(ctx, o.email, (x.kind || 'stop') + ' (company)'); }
    ctx.q('DELETE FROM kv WHERE k=?', k); delete S.kv[k];
    ctx.ev('company_stop_applied', null, x.email, `${only ? 'confirmed by the operator' : pendDays(S) + '-day wait over'}: ${x.kind} from ${x.from}${also}`, 0); done.push(x.email);
  }
  return done;
}
const ckey = t => { t = lc(t); if (/^h:/.test(t)) return t; let h = 0x811c9dc5, g = 0x01000193; for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); h = Math.imul(h ^ c, 16777619) >>> 0; g = Math.imul(g ^ c, 2246822519) >>> 0; } return 'h:' + h.toString(16).padStart(8, '0') + g.toString(16).padStart(8, '0'); };   // pseudonymous complaint-sender key
function complaintCount7(ctx, from) {   // distinct complaint senders in the last 7 days, this one included (an erased sender is counted by its key)
  const set = new Set([ckey(from)]);
  for (const x of ctx.S.events) if (x.kind === 'complaint' && x.at > ctx.now - 7 * DAY && x.target) set.add(ckey(x.target));
  return set.size;
}
function thanksTime(ctx, p) {
  const tz = p.tz || ET; let t = ctx.now + rnd(45, 180) * 60000;
  for (let i = 0; i < 6; i++) {
    const day = dayIn(tz, t), lp = partsIn(tz, t), mins = lp.h * 60 + lp.mi;
    if (recipDay(p.country, day) && mins >= 9 * 60 && mins <= 16 * 60 + 30) return t;
    let next = recipDay(p.country, day) && mins < 9 * 60 ? day : addBusinessDays(day, 1);
    t = zonedToUtc(next, rnd(9 * 60 + 15, 11 * 60), tz);
  }
  return t;
}

// ---------- thresholds ----------
function thresholds(ctx, etDay) {
  const S = ctx.S, now = ctx.now;
  for (const b of Object.values(S.boxes)) {
    if (b.parked || (b.paused_until && Date.parse(b.paused_until) > now)) continue;
    const lastBP = S.events.filter(x => x.kind === 'pause' && x.box === b.email && /^bounces/.test(String(x.detail || ''))).reduce((m, x) => Math.max(m, x.at), 0);
    const since = +(S.kv['resumed_at:' + b.email] || 0);   // an operator resume starts the count afresh (old bounces no longer re-pause it)
    if (!S.events.some(x => x.kind === 'hard_bounce' && x.box === b.email && x.at > Math.max(since, lastBP))) continue;   // only a NEW bounce (after the last bounce pause) can pause again: an expired pause never re-fires on the same old bounce
    const hbToday = S.events.filter(x => x.kind === 'hard_bounce' && x.box === b.email && x.at > since && dayIn(ET, x.at) === etDay).length;
    const last50 = S.sends.filter(s => s.box === b.email && s.kind === 'step' && s.at > since).sort((x, y) => y.at - x.at).slice(0, 50);
    const hb50 = S.events.filter(x => x.kind === 'hard_bounce' && x.box === b.email && x.at > since && last50.some(s => lc(s.to_addr) === lc(x.target))).length;
    if (hbToday >= 2 || (last50.length >= 20 && hb50 / last50.length >= 0.03)) {
      pauseBox(ctx, b, now + 3 * DAY, `bounces: ${hbToday} today, ${hb50}/${last50.length} of last 50`);
      if ((b.ramp_step || 0) > 0) { setBox(ctx, b, { ramp_step: b.ramp_step - 1, step_days: 0 }); ctx.ev('ramp_down', b.email, null, `bounce pause: cap now ${RAMP[b.ramp_step]}/day`); }   // r38: step back one
    }
  }
  const byDom = {}; for (const b of Object.values(S.boxes)) (byDom[dom(b.email)] ||= []).push(b);
  for (const [d, bs] of Object.entries(byDom)) {
    // only reputation pauses (bounces, Mailbox blocks) count; a cascade pause or a network/500 pause never re-triggers the cascade (that looped forever)
    if (bs.length > 1 && bs.filter(b => b.paused_until && Date.parse(b.paused_until) > now && /^(bounces|mailbox block|second mailbox block)/i.test(b.pause_reason || '')).length >= 2)
      for (const b of bs) if (!(b.paused_until && Date.parse(b.paused_until) > now)) pauseBox(ctx, b, now + 3 * DAY, `domain ${d}: two inboxes paused`);
  }
  const g0 = Math.max(now - 7 * DAY, +(S.kv.kill_lifted_at || 0));   // a manual kill-off starts the count afresh, so the same old bounce can't re-fire the stop
  const s7 = S.sends.filter(s => s.at > g0 && s.kind === 'step').length, hb7 = S.events.filter(x => x.kind === 'hard_bounce' && x.at > g0).length;
  if (!laneHeld(S.kv, 'brandb')) {
    const c0 = Math.max(now - 7 * DAY, +(S.kv.kill_brandb_lifted_at || 0)), cs = S.sends.filter(s => s.at > c0 && s.kind === 'step' && S.P[lc(s.to_addr)]?.lane === 'brandb'), ct = new Set(cs.map(s => lc(s.to_addr)));
    const chb = S.events.filter(x => x.kind === 'hard_bounce' && x.at > c0 && ct.has(lc(x.target || ''))).length;
    if (cs.length >= 15 && chb / cs.length >= 0.04) { ctx.kv('kill_brandb', `auto: ${chb}/${cs.length} hard bounces on BrandB sends`); ctx.ev('lane_hold', null, null, `BRANDB COLD HELD: ${chb} hard bounce(s) on ${cs.length} BrandB sends. Check the list (Bouncer), then re-arm.`, 1); }
  }
  if (s7 >= 20 && hb7 / s7 >= 0.05 && !killed(S)) { ctx.kv('kill', `auto: ${hb7}/${s7} hard bounces over 7 days`); ctx.ev('kill', null, null, `global bounce rate 5%+: ${hb7} hard bounce(s) on ${s7} sends since ${new Date(g0).toISOString().slice(0, 16)}Z`, 1); }
}
function pauseBox(ctx, b, untilMs, reason) {
  if (b.paused_until && Date.parse(b.paused_until) > untilMs) return;   // never shorten a longer pause already in force
  setBox(ctx, b, { paused_until: new Date(untilMs).toISOString(), pause_reason: reason });
  for (const s of ctx.S.slots) if (s.box === b.email && s.status === 'pending' && s.kind !== 'thanks') { s.status = 'held'; ctx.q("UPDATE slots SET status='held' WHERE id=?", s.id); }
  ctx.ev('pause', b.email, null, `${reason} (until ${new Date(untilMs).toISOString().slice(0, 16)}Z)`, 1);
}
function onBlock(ctx, b, why) {
  const prev = (b.strikes || []).filter(x => Date.parse(x) > ctx.now - 14 * DAY), last = prev.length ? Date.parse(prev[prev.length - 1]) : 0;
  if (last && !((b.last_send_at || 0) > last)) {   // no successful send since the last strike: the SAME block is still in force (not lifted yet), not a second block
    ctx.ev('block', b.email, null, `still blocked since ${prev[prev.length - 1].slice(0, 16)}Z (no send has succeeded since): ${why}`, 1);
    pauseBox(ctx, b, zonedToUtc(addDays(dayIn(ET, ctx.now), 1), 0, ET), 'Mailbox block still in force: unblock this inbox in Mailbox; stopped for the day');
    return;
  }
  const strikes = prev.concat(new Date(ctx.now).toISOString());
  setBox(ctx, b, { strikes });
  ctx.ev('block', b.email, null, why, 1);
  if (strikes.length >= 2) {
    setBox(ctx, b, { cold_off: 1 }); pauseBox(ctx, b, ctx.now + 7 * DAY, 'second Mailbox block in 14 days: off cold sending (back on cold after 14 days with no further block, one ramp step lower)');
    ctx.kv('cold_off_auto:' + b.email, String(ctx.now));   // r38 (the operator 16 Nov 2026: "pause it", never retire): rollover lifts this after 14 block-free days
    // cold prospects on this inbox: not yet emailed -> free for another inbox; mid-sequence -> the thread lives here, so the sequence ends
    const ended = [];
    for (const p of Object.values(ctx.S.P)) {
      if (p.box !== b.email || p.lane === 'warm' || !['active', 'company_paused'].includes(p.status)) continue;
      if (!(p.step > 0)) { setP(ctx, p, { box: null }); cancelSlots(ctx, p.email, 'inbox off cold'); continue; }
      if (p.status !== 'active') continue;
      setP(ctx, p, { status: 'complete', note: 'inbox off cold: follow-ups ended' }); cancelSlots(ctx, p.email, 'inbox off cold');
      suppress(ctx, p.email, 'sequence_complete', new Date(ctx.now + 75 * DAY).toISOString()); ended.push(p.email);
    }
    if (ended.length) ctx.ev('cold_off_ended', b.email, null, `inbox off cold sending: ${ended.length} follow-up sequence(s) ended: ${ended.join(', ')}`, 1);
  }
  else { const etDay = dayIn(ET, ctx.now); pauseBox(ctx, b, zonedToUtc(addDays(etDay, 1), 0, ET), 'Mailbox block: stopped for the day, no retry'); }
}
const killed = S => { const k = S.kv.kill; return !!k && k !== '0' && k !== 'off'; };
const paused = (b, now) => b.parked || (b.paused_until && Date.parse(b.paused_until) > now);

// ---------- planning ----------
function laneFits(p, b) {
  const coldOk = !b.warm_only && !b.cold_off;
  if (p.box) return p.box === b.email && (p.lane === 'warm' || coldOk);   // an assigned inbox that went off cold sends no more cold (onBlock re-routes or ends those)
  if (p.lane === 'warm') return true;
  return COLD_LANES.includes(p.lane) && b.lane === p.lane && coldOk;
}
function catchAllOk(S, p, b, now) {
  if (p.verify !== 'catch_all') return true;
  if (now - Date.parse(b.start + 'T00:00:00Z') < 30 * DAY) return false;               // none in an inbox's first 30 days
  const recent = S.sends.filter(s => s.box === b.email && s.kind === 'step' && s.at > now - 30 * DAY);
  const ca = recent.filter(s => S.P[lc(s.to_addr)]?.verify === 'catch_all').length;
  return (ca + 1) / (recent.length + 1) <= 0.10;
}
function pickTime(ctx, b, p, etDay, taken, domPlanned = []) {
  const tz = p && p.tz ? p.tz : ET, wins = p && p.tz ? WINDOWS : FALLBACK_WIN, earliest = ctx.now + 5 * 60000;
  const sameDom = Object.values(ctx.S.boxes).filter(x => x.email !== b.email && dom(x.email) === dom(b.email)).map(x => x.email);
  const other = ctx.S.slots.filter(s => sameDom.includes(s.box) && s.et_day === etDay && s.status !== 'cancelled').map(s => s.due_at).concat(domPlanned.filter(x => x[0] !== b.email && dom(x[0]) === dom(b.email)).map(x => x[1]));
  for (let i = 0; i < 80; i++) {
    const w = wins[rnd(0, wins.length - 1)], t = zonedToUtc(etDay, rnd(w[0], w[1] - 15), tz) + rnd(0, 59) * 1000;   // 15 min buffer: tick lag + same-domain deferral never push a send past the window end
    if (t < earliest) continue;
    if (taken.some(x => Math.abs(x - t) < MIN_GAP)) continue;
    if (other.some(x => Math.abs(x - t) < 6 * 60000)) continue;   // sibling inboxes on one domain planned 6+ min apart (ticks are 5 min)
    return t;
  }
  return null;
}
async function plan(ctx, etDay) {
  const S = ctx.S, now = ctx.now, live = S.slots.filter(s => s.et_day === etDay && ['pending', 'sent', 'dry', 'claimed'].includes(s.status));
  const slotted = new Set(live.filter(s => s.kind === 'step').map(s => s.email));
  const boxes = Object.values(S.boxes).filter(b => !paused(b, now) && ctx.cfg.boxes?.[b.email]);
  const rem = {}, taken = {};
  for (const b of boxes) {
    const used = sendsOn(S, b.email, etDay).length, pend = live.filter(s => s.box === b.email && ['pending', 'claimed'].includes(s.status) && COUNTED.has(s.kind)).length;
    rem[b.email] = capOf(S, b, now) - used - pend;
    taken[b.email] = S.sends.filter(s => s.box === b.email && s.et_day === etDay).map(s => s.at).concat(live.filter(s => s.box === b.email).map(s => s.due_at));
  }
  const companyDay = new Set(S.sends.filter(s => s.et_day === etDay).map(s => dom(s.box) + '|' + (S.P[lc(s.to_addr)]?.company || '')).concat(live.map(s => dom(s.box) + '|' + (S.P[s.email]?.company || ''))));
  const newSlots = [], domPlanned = [];
  // weekly seed per inbox (Tue-Thu) is planned FIRST so a full queue can never starve it (the ramp gate needs a weekly inbox result)
  for (const b of boxes) {
    if (rem[b.email] <= 0 || ![2, 3, 4].includes(dow(etDay))) continue;
    if (S.seeds.some(x => x.box === b.email && x.sent_at > now - 6 * DAY && !String(x.placement || '').startsWith('test:')) || live.some(s => s.box === b.email && s.kind === 'seed')) continue;
    const last = S.sends.filter(s => s.box === b.email && s.kind === 'step' && s.at > now - 14 * DAY && S.steps[lc(s.to_addr)]).sort((x, y) => y.at - x.at)[0];
    if (!last) continue;
    const t = pickTime(ctx, b, null, etDay, taken[b.email], domPlanned); if (!t) continue;
    taken[b.email].push(t); domPlanned.push([b.email, t]); rem[b.email]--;
    newSlots.push([etDay, b.email, lc(last.to_addr), 0, 'seed', t]);
  }
  const due = Object.values(S.P).filter(p => p.status === 'active' && !slotted.has(p.email) && (p.lane === 'warm' || (!laneHeld(S.kv, p.lane) && recipDay(p.country, dayIn(p.tz || ET, zonedToUtc(etDay, 12 * 60, p.tz || ET))))) && (!p.next_due || p.next_due <= etDay) && (!p.resume_date || p.resume_date <= etDay) && !suppressed(S, p.email, now))
    .sort((a, b) => (b.step - a.step) || (isCoach(b) - isCoach(a)) || String(a.created_at).localeCompare(String(b.created_at)));   // r33: coach batches first among equals
  let progress = true;
  while (progress) {
    progress = false;
    for (const b of boxes.sort((x, y) => rem[y.email] - rem[x.email])) {
      if (rem[b.email] <= 0) continue;
      const idx = due.findIndex(p => laneFits(p, b) && (p.step > 0 || catchAllOk(S, p, b, now)) &&   /* catch-all rule gates the first email only; a delivered thread continues */ !(p.company && companyDay.has(dom(b.email) + '|' + p.company)) &&
        S.steps[p.email]?.[p.step]);   // verification age: step 0 is re-verified at send time (sendOne); follow-ups continue a thread already delivered
      if (idx < 0) continue;
      const p = due.splice(idx, 1)[0], t = pickTime(ctx, b, p, etDay, taken[b.email], domPlanned);
      if (!t) continue; domPlanned.push([b.email, t]);
      // the person is bound to an inbox at the first successful send (afterSent), so an unsent plan never ties them to a dead or paused inbox
      taken[b.email].push(t); rem[b.email]--; if (p.company) companyDay.add(dom(b.email) + '|' + p.company);
      newSlots.push([etDay, b.email, p.email, p.step, 'step', t]); progress = true;
    }
  }
  if (newSlots.length && ctx.preview) { for (const r of newSlots) ctx.out.push(`PREVIEW ${new Date(r[5]).toISOString().slice(0, 16)}Z ${r[1]} -> ${r[2]} ${r[4]}/${r[3]}`); return; }
  if (newSlots.length) {
    const rows = await ctx.db.batch(newSlots.map(r => ctx.db.prepare('INSERT INTO slots(et_day,box,email,step,kind,due_at,status) VALUES(?,?,?,?,?,?,?) RETURNING id').bind(...r, 'pending')));
    newSlots.forEach((r, i) => S.slots.push({ id: rows[i].results[0].id, et_day: r[0], box: r[1], email: r[2], step: r[3], kind: r[4], due_at: r[5], status: 'pending' }));
    ctx.out.push(`planned ${newSlots.length} slot(s)`);
  }
}

// ---------- sending ----------
async function acctOk(ctx, b) {
  if (ctx.now - (b.last_acct_check || 0) < 25 * 60000 && !b._mustCheck) return true;
  const r = await zapi(ctx, b.email, 'GET', '/accounts'); setBox(ctx, b, { last_acct_check: ctx.now });
  const L = r.s === 200 && Array.isArray(r.d.data) ? r.d.data : [];   // Mailbox error bodies carry data as an object
  const a = L.find(x => lc(x.primaryEmailAddress) === b.email) || L[0];
  if (r.s !== 200 || !a) { ctx.ev('acct_check_error', b.email, null, `${r.s} ${r.text.slice(0, 120)}: sends from this inbox held`, 1); return false; }
  if (a.outgoingBlocked) { onBlock(ctx, b, 'outgoingBlocked flag set on account'); return false; }
  return true;
}
async function sentFolder(ctx, b) {
  if (b.sent_folder) return b.sent_folder;
  const r = await zapi(ctx, b.email, 'GET', `/accounts/${aidOf(ctx, b.email)}/folders`);
  const f = (r.s === 200 && Array.isArray(r.d.data) ? r.d.data : []).find(x => x.folderType === 'Sent' || x.folderName === 'Sent'); if (f) setBox(ctx, b, { sent_folder: String(f.folderId) });
  return f ? String(f.folderId) : null;
}
function afterSent(ctx, b, slot, p, mid, subject, etDay) {
  const S = ctx.S, iso = new Date(ctx.now).toISOString(), to = slot.kind === 'seed' ? slot._seed : (p ? p.email : slot.email);
  S.sends.push({ box: b.email, to_addr: to, at: ctx.now, kind: slot.kind, et_day: etDay });
  ctx.q('INSERT INTO sends(box,to_addr,at,kind,et_day) VALUES(?,?,?,?,?)', b.email, to, ctx.now, slot.kind, etDay);
  ctx.q("UPDATE attempts SET status='sent', sent_at=?, message_id=? WHERE key=?", iso, mid, slot._key);
  ctx.q("UPDATE slots SET status='sent' WHERE id=?", slot.id); slot.status = 'sent';
  setBox(ctx, b, { last_send_at: ctx.now });
  if (slot.kind === 'seed') { ctx.q('INSERT INTO seeds(box,seed,subject,sent_at) VALUES(?,?,?,?)', b.email, to, subject, ctx.now); S.seeds.push({ box: b.email, seed: to, subject, sent_at: ctx.now }); return; }
  if (!p) return;   // prospect erased (EU stop) before reconcile confirmed the send: the send is recorded, nothing else to update
  if (slot.kind === 'thanks') { setP(ctx, p, { note: 'thanked' }); return; }
  const n = p.step + 1, f = { step: n };
  if (p.step === 0) { f.thread_mid = mid; if (!p.box) f.box = b.email; }   // bind the person to this inbox for the whole sequence
  if (n >= Math.min(p.nsteps || 1, +(S.kv.max_steps || 99))) {   // r30: hard send-time cap, a 3rd step never sends when kv.max_steps=2
    f.status = p.lane === 'warm' ? 'sent_awaiting' : 'complete';
    if (p.lane !== 'warm') suppress(ctx, p.email, 'sequence_complete', new Date(ctx.now + 75 * DAY).toISOString());
  } else f.next_due = addSendDays(etDay, STEP_OFFSETS[n] - STEP_OFFSETS[n - 1], p.country);
  if (!['active', 'sent_awaiting'].includes(p.status)) { delete f.status; delete f.next_due; }   // reconcile confirming a send after a stop/reply/bounce never overwrites that status
  setP(ctx, p, f);
}
async function sendOne(ctx, b, slot, etDay) {
  const S = ctx.S, now = ctx.now, p = slot.kind === 'seed' ? null : S.P[slot.email];
  const hold = (st, why) => { slot.status = st; ctx.q('UPDATE slots SET status=?, ref=? WHERE id=?', st, why, slot.id); ctx.out.push(`slot ${slot.id} ${st}: ${why}`); };
  if (slot.kind !== 'seed' && !p) return hold('void', 'prospect missing');
  if (slot.kind === 'step' && p.status !== 'active') return hold('void', 'prospect ' + p.status);
  if (slot.kind === 'thanks' && !['replied'].includes(p.status)) return hold('void', 'no longer replied');
  if (slot.kind === 'thanks' && S.kv.warm_thanks !== 'on') return hold('void', 'automated thanks is off');
  if (now - slot.due_at > 60 * 60000 && slot.kind !== 'thanks') return hold('missed', 'tick ran late');
  if (slot.kind === 'thanks') { const tz = p.tz || ET, lp = partsIn(tz, now), mins = lp.h * 60 + lp.mi; if (now - slot.due_at > 2 * DAY) return hold('void', 'thanks too late'); if (!recipDay(p.country, dayIn(tz, now)) || mins < 9 * 60 || mins > 16 * 60 + 30) return; }
  if (slot.kind === 'step') {   // a late slot never lands outside the recipient's business window
    const tz = p?.tz || ET, lp = partsIn(tz, now), mins = lp.h * 60 + lp.mi, wins = p?.tz ? WINDOWS : FALLBACK_WIN;
    if (!recipDay(p?.country, dayIn(tz, now)) || !wins.some(w => mins >= w[0] && mins < w[1])) return hold('missed', 'outside recipient window or a recipient holiday');
  }
  if (now - (b.last_send_at || 0) < MIN_GAP) return;   // keep the gap; stays pending
  if (slot.kind !== 'seed') {   // never send while this inbox's replies can't be read (a stop/reply would go unseen); poll() runs first each tick
    const ok = +(S.kv['poll_ok:' + b.email] || 0), age = now - ok, ak = 'poll_stale_at:' + b.email;
    if (age > 45 * 60000) {
      if (now - (+(S.kv[ak] || 0)) > 6 * 3600000) { ctx.kv(ak, String(now)); ctx.ev('poll_stale', b.email, null, `no successful inbox poll for ${ok ? Math.round(age / 60000) + ' min' : 'ever (never polled)'}: sends from ${b.email} held until polling works`, 1); }
      ctx.out.push(`slot ${slot.id}: inbox poll stale, held`); return;
    }
    // r26: a message from an address we never emailed, on ANY inbox, pauses all cold sending: so every inbox must have been read recently too
    if (slot.kind !== 'thanks') { const stale = Object.values(S.boxes).filter(x => ctx.cfg.boxes?.[x.email] && x.email !== b.email && (now - (+(S.kv['poll_ok:' + x.email] || 0)) > 45 * 60000 || S.kv['poll_partial:' + x.email] || (ctx.unread && ctx.unread.has(x.email))));
      if (stale.length) { const k2 = 'poll_stale_at:' + stale[0].email; if (now - (+(S.kv[k2] || 0)) > 6 * 3600000) { ctx.kv(k2, String(now)); ctx.ev('poll_stale', stale[0].email, null, `inbox not read for over 45 min (or only partly read): ALL cold sends held until it is read (a stop or a stranger's message may be waiting there)`, 1); }
        ctx.out.push(`slot ${slot.id}: ${stale.length} other inbox(es) not read recently (${stale.slice(0, 3).map(x => x.email).join(', ')}), held`); return; } }
    if (S.kv['poll_partial:' + b.email]) { ctx.out.push(`slot ${slot.id}: this inbox's listing was only partly read (an older page failed), held until paging succeeds`); return; }   // persists across ticks: the inbox is not polled every tick
    if (ctx.unread && ctx.unread.has(b.email)) { ctx.out.push(`slot ${slot.id}: unread inbound on this inbox, held to next tick`); return; }   // a stop/reply may be among them
  }
  const to = slot.kind === 'seed' ? SEEDS[(Object.keys(S.boxes).indexOf(b.email) + Math.floor(now / (7 * DAY))) % SEEDS.length] : p.email;
  slot._seed = to;
  if (slot.kind !== 'seed') {
    const fresh = await ctx.db.prepare('SELECT 1 FROM suppression WHERE email=? AND (until IS NULL OR until > ?)').bind(lc(to), new Date(now).toISOString()).first();
    if (fresh || suppressed(S, to, now)) { cancelSlots(ctx, p.email, 'suppressed'); return hold('void', 'suppressed'); }
  }
  if (slot.kind === 'step' && slot.step === 0 && p.verified_at && now - Date.parse(p.verified_at) >= 45 * DAY) {   // first email on a verification older than 45 days: verify again
    const v = await verifyAddr(ctx, p.email);
    if (/^error/.test(v)) { ctx.ev('reverify_error', b.email, p.email, `Bouncer unavailable (${v}): first email to ${p.email} held, retried next tick`, 1); return; }
    setP(ctx, p, { verify: v, verified_at: new Date(now).toISOString() });
    if (!['ok', 'catch_all'].includes(v)) { setP(ctx, p, { status: 'skipped_verify' }); ctx.ev('reverify_failed', b.email, p.email, `re-verification (old one >45 days): Bouncer ${v}; prospect skipped`, 1); return hold('void', 'reverify: ' + v); }
    if (!catchAllOk(S, p, b, now)) return hold('missed', 're-verified as catch-all; replanned under the catch-all rule');
  }
  if (slot.kind === 'step') {
    const mx = await mxClass(ctx, to);
    if (mx === 'microsoft' && S.kv.ms_open !== '1') { setP(ctx, p, { status: 'skipped_microsoft', mx }); return hold('void', 'microsoft-hosted'); }
    if (mx === 'none') { setP(ctx, p, { status: 'skipped_nomx', mx }); return hold('void', 'no MX'); }
    const dk = 'dnsfail:' + p.email;
    if (mx === 'error') {   // held, never sent blind; counted per sending day, alerted, and parked after 3 failing days
      const days = String(S.kv[dk] || '').split(',').filter(Boolean);
      if (!days.includes(etDay)) {
        days.push(etDay); ctx.kv(dk, days.join(','));
        if (days.length >= 3) { setP(ctx, p, { status: 'held_dns', mx }); cancelSlots(ctx, p.email, 'dns'); ctx.ev('held_dns', b.email, p.email, `MX lookup for ${p.email} failed on ${days.length} sending days (${days.join(', ')}): prospect parked as held_dns (set status back to active to retry)`, 1); return hold('void', 'DNS failing 3 days'); }
        ctx.ev('dns_error', b.email, p.email, `MX lookup for ${p.email} failed (day ${days.length} of 3): send held, retried next tick`, 1);
      }
      ctx.out.push(`slot ${slot.id}: DNS lookup failed, retry next tick`); return;
    }
    if (S.kv[dk]) { delete S.kv[dk]; ctx.q('DELETE FROM kv WHERE k=?', dk); }
  }
  b._mustCheck = true; if (!(await acctOk(ctx, b))) return;
  // content
  let subject, body, replyTo = null;
  if (slot.kind === 'thanks') { subject = 'Re: ' + (S.steps[p.email]?.[0]?.subject || ''); body = THANKS[rnd(0, THANKS.length - 1)]; replyTo = slot.ref; }
  else {
    const st = S.steps[slot.email]?.[slot.step]; if (!st) return hold('void', 'step content missing');
    const lane = S.P[slot.email]?.lane || 'warm';
    subject = st.subject; body = st.body.trim() + (lane === 'warm' ? '' : (pp => footerFor({ ...pp, company: pp.display_company || pp.company, privacy_live: S.kv.privacy_live === '1' }))(p || S.P[slot.email] || { email: slot.email }));
    if (slot.kind === 'step' && slot.step > 0) { replyTo = p.thread_mid; subject = 'Re: ' + S.steps[p.email][0].subject; if (!replyTo) { setP(ctx, p, { status: 'complete', note: 'follow-up skipped: no thread id' }); cancelSlots(ctx, p.email, 'no thread id'); ctx.ev('no_thread', b.email, p.email, 'follow-up skipped, sequence ended', 1); return hold('void', 'no thread id'); } }
  }
  if (S.kv.mode !== 'live' || S.kv.live_version !== ctx.version) { ctx.ev('dry_send', b.email, to, `${slot.kind} step ${slot.step}: ${subject}`); return hold('dry', 'dry-run'); }
  const key = slot.kind === 'thanks' ? 'thanks|' + p.email : slot.kind === 'seed' ? `seed|${b.email}|${etDay}` : `${p.email}|${slot.step}`;
  slot._key = key;
  if (ctx.zcalls > 22 - 3 || ctx.fetches > FETCH_BUDGET - 4 || Date.now() - ctx.t0 > 120000) return;   // not enough budget (calls or tick time) left to send and retry a token: stays pending
  const kvNow = Object.fromEntries(((await ctx.db.prepare("SELECT k, v FROM kv WHERE k IN ('kill','mode','kill_brandb')").all()).results || []).map(x => [x.k, x.v]));
  if ((kvNow.kill && kvNow.kill !== '0' && kvNow.kill !== 'off') || kvNow.mode !== 'live') { ctx.out.push(`slot ${slot.id}: kill/dry set during this tick, held`); return; }
  // the DB row, or a hold set earlier in this same tick (a complaint read by this tick's poll is not committed yet)
  if (slot.kind !== 'seed' && (laneHeld(kvNow, S.P[slot.email]?.lane) || laneHeld(S.kv, S.P[slot.email]?.lane))) { ctx.out.push(`slot ${slot.id}: ${S.P[slot.email]?.lane} lane held, not sent`); return; }   // the stop button takes effect mid-tick
  const claim = await ctx.db.prepare('INSERT OR IGNORE INTO attempts(key,email,step,kind,box,status,claimed_at,slot_id,subject) VALUES(?,?,?,?,?,?,?,?,?)').bind(key, to, slot.step, slot.kind, b.email, 'claimed', now, slot.id, subject).run();
  if (!claim.meta.changes) return hold('void', 'already attempted ' + key);
  ctx.inSend = true;
  // Seeds are the operator's own Workspace inboxes (user name Alex Operator): a matching display name trips Gmail's employee-name spoof filter and fakes a spam result, so seeds go out with the bare address.
  const payload = { fromAddress: slot.kind === 'seed' ? b.email : `Alex Operator <${b.email}>`, toAddress: to, subject, content: body, mailFormat: 'plaintext' };
  let r;
  try {
    r = replyTo ? await zapi(ctx, b.email, 'POST', `/accounts/${aidOf(ctx, b.email)}/messages/${replyTo}`, { ...payload, action: 'reply' })
      : await zapi(ctx, b.email, 'POST', `/accounts/${aidOf(ctx, b.email)}/messages`, payload);
  } catch (err) {
    // network error or timeout mid-send: we can't know if Mailbox sent it. Leave the claim for reconcile (checks the Sent folder), rest this inbox 2h.
    ctx.inSend = false; if (err instanceof Budget) throw err;
    hold('claimed', 'network error during send, reconcile decides');
    pauseBox(ctx, b, now + 2 * 3600000, 'network error during send: ' + String(err).slice(0, 120));
    ctx.ev('send_net_error', b.email, to, String(err).slice(0, 300), 1); return;
  }
  if (r.s >= 500 && !BLOCK_RX.test(r.text)) {   // gateway/server error: Mailbox may have sent it. Same path as a network error.
    ctx.inSend = false; hold('claimed', `mailbox ${r.s}, reconcile decides`);
    pauseBox(ctx, b, now + 2 * 3600000, `send error ${r.s}: ${r.text.slice(0, 120)}`); ctx.ev('send_net_error', b.email, to, `${r.s} ${r.text.slice(0, 200)}`, 1); return;
  }
  const ok2 = r.s >= 200 && r.s < 300;
  if (ok2 && (r.d.raw !== undefined || (slot.kind === 'step' && slot.step === 0 && !(r.d.data && r.d.data.messageId)))) {
    // a 2xx that is not JSON (or a first email with no message id to thread on): we can't tell what happened. Same path as a network error.
    ctx.inSend = false; hold('claimed', `mailbox ${r.s} without a usable body, reconcile decides`);
    pauseBox(ctx, b, now + 2 * 3600000, `send returned ${r.s} without a usable body: ${r.text.slice(0, 100)}`); ctx.ev('send_net_error', b.email, to, `${r.s} unusable body ${r.text.slice(0, 200)}`, 1); return;
  }
  if (ok2) {
    const mid = String((r.d.data && r.d.data.messageId) || '');
    afterSent(ctx, b, slot, p, mid, subject, etDay); ctx.out.push(`SENT ${b.email} -> ${to} (${slot.kind} ${slot.step})`);
  } else {
    ctx.q("UPDATE attempts SET status='failed', error=?, key=? WHERE key=?", r.text.slice(0, 300), key + '#failed' + now, key);
    hold('failed', `${r.s}`);
    if (BLOCK_RX.test(r.text) || r.s === 403) onBlock(ctx, b, `${r.s} ${r.text.slice(0, 200)}`);
    else if (ZAUTH_RX.test(r.text)) pauseBox(ctx, b, ctx.now + 3600000, `Mailbox refused the access token (${r.s} ${r.text.slice(0, 120)}): sends from this inbox held 1h; re-authorize if it repeats`);
    else if (slot.kind === 'step' && slot.step > 0 && [400, 404, 422].includes(r.s)) { setP(ctx, p, { status: 'complete', note: `follow-up refused ${r.s}` }); cancelSlots(ctx, p.email, 'follow-up refused'); ctx.ev('followup_refused', b.email, p.email, `${r.s} ${r.text.slice(0, 200)}`, 1); }
    else pauseBox(ctx, b, zonedToUtc(addDays(etDay, 1), 0, ET), `send error ${r.s}: ${r.text.slice(0, 150)}`);
  }
  ctx.inSend = false;
}
async function reconcile(ctx, etDay) {
  const S = ctx.S;
  for (const a of S.claimed) {
    if (ctx.now - a.claimed_at < 10 * 60000) continue;   // give Mailbox's Sent folder time to show it
    const b = S.boxes[a.box]; if (!b) continue;
    let fid, r;
    try { fid = await sentFolder(ctx, b); if (!fid) continue; r = await zapi(ctx, b.email, 'GET', `/accounts/${aidOf(ctx, b.email)}/messages/view?folderId=${fid}&limit=50`); }
    catch (err) { if (err instanceof Budget) return; ctx.out.push('reconcile retry later: ' + err); continue; }
    if (r.s !== 200 || !Array.isArray(r.d && r.d.data)) continue;   // never void on a failed lookup: a 200 that is not a JSON list (HTML page, error object) is a failed lookup, not an empty Sent folder (same rule as poll)
    const known = new Set((await ctx.env.DB.prepare("SELECT message_id FROM attempts WHERE box=? AND status='sent' AND message_id IS NOT NULL").bind(b.email).all()).results.map(x => String(x.message_id)));
    // receivedTime = when Mailbox stored the Sent copy (epoch ms). sentDateInGMT is NOT usable here: Mailbox's own samples show it a whole
    // time-zone offset (5h30m) behind receivedTime, so for an account zone east of UTC (Europe/Prague) the real Sent copy looked older
    // than the claim, was voided, and the same email went out again. Fall back to sentDateInGMT only with a +-14h zone allowance.
    const sentAt = m => +(m.receivedTime || 0) ? { t: +m.receivedTime, slack: 2 * 60000 } : { t: +(m.sentDateInGMT || 0), slack: 14 * 3600000 };
    const sk = t => lc(unent(t)).replace(/\s+/g, ' ').trim();   // compare subjects whitespace-folded: a mismatch here voids a real send and the email goes out again
    const hit = r.d.data.map(zmsg).find(m => lc(m.toAddress).includes(lc(a.email)) && sk(m.subject) === sk(a.subject) && !known.has(String(m.messageId)) && (sentAt(m).t === 0 || sentAt(m).t >= a.claimed_at - sentAt(m).slack));
    const slot = S.slots.find(s => s.id === a.slot_id) || { id: a.slot_id, kind: a.kind, step: a.step, email: a.email };
    slot._key = a.key; slot._seed = a.email;
    if (hit) { const lastBefore = b.last_send_at || 0; afterSent(ctx, b, slot, S.P[a.email], String(hit.messageId), a.subject, dayIn(ET, a.claimed_at)); setBox(ctx, b, { last_send_at: Math.max(lastBefore, a.claimed_at) }); ctx.ev('reconciled_sent', b.email, a.email, a.key); }   // the send happened at claim time: a late confirmation must not look like a send that succeeded after a later Mailbox block (onBlock would count the same block twice)
    else { ctx.q("UPDATE attempts SET status='void', key=? WHERE key=?", a.key + '#void' + ctx.now, a.key); ctx.q("UPDATE slots SET status='failed', ref='reconcile: not in Sent' WHERE id=?", a.slot_id); ctx.ev('reconciled_void', b.email, a.email, a.key, 1); }
  }
}
async function sendDue(ctx, etDay) {
  const S = ctx.S, byBox = {};
  for (const s of S.slots) if (s.status === 'pending' && s.due_at <= ctx.now) (byBox[s.box] ||= []).push(s);
  for (const [e, list] of Object.entries(byBox)) {
    const b = S.boxes[e]; if (!b || paused(b, ctx.now)) continue;
    list.sort((x, y) => x.due_at - y.due_at);
    // stale slots first, so a late tick never fires two in one go
    for (const s of list.filter(s => ctx.now - s.due_at > 60 * 60000 && s.kind !== 'thanks')) { s.status = 'missed'; ctx.q("UPDATE slots SET status='missed', ref='tick ran late' WHERE id=?", s.id); }
    const next = list.find(s => s.status === 'pending'); if (!next) continue;
    const sib = Object.values(S.boxes).filter(x => x.email !== e && dom(x.email) === dom(e)).reduce((m, x) => Math.max(m, x.last_send_at || 0), 0);
    if (ctx.now - sib < 2 * 60000) continue;   // a sibling inbox on this sending domain sent < 2 min ago (this tick or the last): leave it pending
    try { await sendOne(ctx, b, next, etDay); }
    catch (err) {
      if (err instanceof Budget) return;
      if (ctx.inSend) { ctx.kv('kill', 'auto: exception in send path: ' + String(err).slice(0, 150)); ctx.ev('kill', b.email, null, 'exception in send path: ' + String(err), 1); return; }
      ctx.ev('send_prep_error', b.email, next.email, String(err), 1);
    }
  }
}

// ---------- seeds ----------
async function seedChecks(ctx) {
  for (const s of ctx.S.seeds.filter(x => !x.placement && x.id && ctx.now - x.sent_at > 10 * 60000).slice(0, 2)) {
    try {
      const tok = await gtoken(ctx, s.seed, 'gmail.modify');
      const q = encodeURIComponent(`from:${s.box} subject:"${s.subject.replace(/"/g, '')}" newer_than:3d`);
      const r = await ctx.f(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&includeSpamTrash=true&maxResults=3`, { headers: { Authorization: 'Bearer ' + tok } });
      const j = await r.json(); let placement = null;
      if (j.messages && j.messages.length) {
        const m = await (await ctx.f(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${j.messages[0].id}?format=minimal`, { headers: { Authorization: 'Bearer ' + tok } })).json();
        const L = m.labelIds || []; placement = L.includes('SPAM') ? 'spam' : L.includes('CATEGORY_PROMOTIONS') ? 'promotions' : L.includes('INBOX') ? 'inbox' : 'other';
        // the operator 19 Nov 2026: seed copies cluttered his inboxes. Once placement is read, archive it and mark it read (spam copies stay in spam).
        if (placement !== 'spam') try { await ctx.f(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${j.messages[0].id}/modify`, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ removeLabelIds: ['INBOX', 'UNREAD'] }) }); } catch (e) { if (e instanceof Budget) throw e; }
      } else if (ctx.now - s.sent_at > 3 * 3600000) placement = 'missing';
      if (placement) { s.placement = placement; ctx.q('UPDATE seeds SET placement=?, checked_at=? WHERE id=?', placement, ctx.now, s.id); ctx.ev('seed', s.box, s.seed, placement, placement === 'inbox' ? 0 : 1); }
    } catch (err) { if (err instanceof Budget) return; ctx.ev('seed_error', s.box, s.seed, String(err)); }
  }
}

// ---------- reporting ----------
function statusText(ctx, etDay) {
  const S = ctx.S, now = ctx.now, L = [];
  L.push(`Mode: ${S.kv.mode === 'live' && S.kv.live_version === ctx.version ? 'LIVE' : 'DRY-RUN'}   Kill: ${killed(S) ? S.kv.kill : 'off'}   BrandB cold: ${laneHeld(S.kv, 'brandb') ? 'HELD (' + (S.kv.kill_brandb || 'not armed') + ')' : 'armed'}   ET day: ${etDay}`);
  for (const b of Object.values(S.boxes)) {
    const sent = sendsOn(S, b.email, etDay).length, pend = S.slots.filter(s => s.box === b.email && s.et_day === etDay && s.status === 'pending').length;
    L.push(`${b.email}: ${sent}/${capOf(S, b, now)} sent today, ${pend} pending | ramp week ${(b.ramp_step || 0) + 1} (${b.step_days || 0} sending days at this step)${paused(b, now) ? ` | PAUSED until ${b.paused_until?.slice(0, 16)} (${b.pause_reason})` : ''}${b.cold_off ? ' | off cold' : ''}${b.warm_only ? ' | warm only' : ''}`);
  }
  const cnt = {}; for (const p of Object.values(S.P)) cnt[p.status] = (cnt[p.status] || 0) + 1;
  L.push('Prospects: ' + Object.entries(cnt).map(([k, v]) => `${k} ${v}`).join(', '));
  return L.join('\n');
}
async function digest(ctx, etDay) {
  const S = ctx.S, last = +(S.kv.last_digest_at || 0), since = last ? Math.max(ctx.now - 14 * DAY, Math.min(last, ctx.now - DAY)) : ctx.now - DAY;   // everything since the previous digest (Friday evening, weekends, holidays, outages), not just 24h
  const ev = S.events.filter(e => e.at > since && e.kind !== 'dry_send');
  const cnt = {}; for (const e of ev) cnt[e.kind] = (cnt[e.kind] || 0) + 1;
  const lines = [statusText(ctx, etDay), '', `Since ${new Date(since).toISOString().slice(0, 16)}Z: ` + (Object.entries(cnt).map(([k, v]) => `${k} ${v}`).join(', ') || 'no events')];
  // what needs the operator (every alerted event, and warm replies, which are reported only here) is always listed in full; routine events (poll errors in an outage) are capped
  const ln = e => `- ${new Date(e.at).toISOString().slice(11, 16)}Z ${e.kind} ${e.box || ''} ${e.target || ''} ${String(e.detail || '').slice(0, 160)}`;
  const act = ev.filter(e => +e.alert || e.kind === 'warm_reply'), rest = ev.filter(e => !(+e.alert || e.kind === 'warm_reply'));
  if (act.length) { lines.push('', `Needs you / alerted (${act.length}):`); if (act.length > 300) lines.push(`(${act.length - 300} earlier not listed: see the events table)`); for (const e of act.slice(-300)) lines.push(ln(e)); lines.push(''); }
  if (rest.length > 60) lines.push(`(${rest.length - 60} earlier routine event(s) not listed)`);
  for (const e of rest.slice(-60)) lines.push(ln(e));
  const sends = S.sends.filter(s => s.at > since); lines.push('', `Sends since then: ${sends.length}`); for (const s of sends) lines.push(`- ${s.box} -> ${s.to_addr} (${s.kind})`);
  await gmailSend(ctx, `Sequencer digest ${etDay}`, lines.join('\n'));
}

// ---------- tick ----------
let LOADFAIL_AT = 0;
async function tick(env, opts = {}) {
  const now = Date.now(), db = env.DB;
  const got = await db.prepare("UPDATE kv SET v=? WHERE k='lock' AND CAST(v AS INTEGER) < ?").bind(String(now + 4 * 60000), now).run();
  if (!got.meta.changes) return ['locked: another tick is running'];
  const ctx = new Ctx(env, now); ctx.version = env.CF_VERSION_METADATA?.id || 'dev';
  try {
    const S = await loadState(ctx), etDay = dayIn(ET, now), etP = partsIn(ET, now), active = isSendingDay(etDay);   // recipient windows gate each send; Europe opens ~01:30 ET, Hawaii closes ~21:40 ET
    if (!active && !opts.force && new Date(now).getUTCMinutes() % 30 >= 5) { ctx.out.push('off-hours: skipping'); ctx.ok = true; return ctx.out; }
    if (S.kv.mode === 'live' && S.kv.live_version !== ctx.version && S.kv.mode_alerted !== ctx.version) { ctx.kv('mode_alerted', ctx.version); ctx.ev('dry_after_deploy', null, null, 'New code deployed: sending is in dry-run until re-armed.', 1); }
    await poll(ctx, etDay);
    thresholds(ctx, etDay);
    applyPending(ctx);
    if (isSendingDay(etDay)) {
      rollover(ctx, etDay);
      await reconcile(ctx, etDay);
      if (!killed(S)) { await plan(ctx, etDay); await sendDue(ctx, etDay); }
      else ctx.out.push('killed: ' + S.kv.kill);
    }
    await seedChecks(ctx);
    if (isSendingDay(etDay) && etP.h >= 18 && S.kv.last_digest !== etDay) { try { await digest(ctx, etDay); ctx.kv('last_digest', etDay); ctx.kv('last_digest_at', String(now)); } catch (err) { ctx.out.push('digest failed ' + err); } }
    ctx.ok = true;
  } catch (err) {
    ctx.err = err; if (err instanceof Budget) ctx.ok = true;   // running out of per-tick budget is normal; anything else is a failed tick
    if (!(err instanceof Budget)) { ctx.q('INSERT INTO events(at,kind,detail,alert) VALUES(?,?,?,1)', now, 'exception', String(err.stack || err).slice(0, 600)); ctx.alerts.push('EXCEPTION ' + String(err)); }
    ctx.out.push('error: ' + err);
  } finally {
    if (ctx.S) {
      // identical alerts (a recurring exception, the same pause) go out once per 6h; alerts that fail to send are carried to the next tick, never dropped
      let hist = {}, carry = []; try { hist = JSON.parse(ctx.S.kv.alert_hist || '{}'); carry = JSON.parse(ctx.S.kv.alert_carry || '[]'); } catch { }
      for (const k of Object.keys(hist)) if (now - hist[k] > DAY) delete hist[k];
      const fresh = ctx.alerts.filter(a => { const h = a.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, '').slice(0, 300); if (hist[h] && now - hist[h] < 6 * 3600000) return false; hist[h] = now; return true; });
      // a long Gmail outage: keep up to 300 carried alerts and SAY how many older ones were dropped (the old silent slice(-40) lost the first 40+, e.g. a DATA REQUEST)
      let all = carry.concat(fresh); const CAP = 300;
      if (all.length > CAP) { let lost = 0; all = all.filter(a => { const m = /^ALERTS DROPPED (\d+)/.exec(a); if (m) { lost += +m[1]; return false; } return true; }); lost += Math.max(0, all.length - (CAP - 1)); all = all.slice(-(CAP - 1)); if (lost) all.unshift(`ALERTS DROPPED ${lost} older alert(s) while the alert email was failing\nThey are in the events table: SELECT * FROM events WHERE alert=1 ORDER BY at DESC`); }
      if (all.length) {
        try { await gmailSend(ctx, all.length === 1 ? `Sequencer alert: ${all[0].split('\n')[0].slice(0, 80)}` : `Sequencer alerts (${all.length}): ${[...new Set(all.map(a => a.split(' ')[0]))].join(', ')}`, all.join('\n\n') + '\n\n' + statusText(ctx, dayIn(ET, now))); ctx.kv('alert_carry', '[]'); }
        catch (err) { ctx.out.push('alert mail failed ' + err); ctx.kv('alert_carry', JSON.stringify(all)); }
      }
      if (fresh.length || Object.keys(hist).length) ctx.kv('alert_hist', JSON.stringify(hist));
    } else {
      // state never loaded (bad row, D1 read failure): still tell the operator, at most once per 6h
      try {
        let last = LOADFAIL_AT; try { last = Math.max(last, +((await db.prepare("SELECT v FROM kv WHERE k='loadfail_alert_at'").first())?.v || 0)); } catch { }
        if (now - last > 6 * 3600000) {
          LOADFAIL_AT = now; ctx.S = { tokens: {}, kv: {} };
          await gmailSend(ctx, 'Sequencer alert: tick failing before state load', `Every tick is failing while loading state, so nothing is polled or sent.\n\n${String(ctx.err && (ctx.err.stack || ctx.err)).slice(0, 1500)}`);
          ctx.W.push(db.prepare("INSERT OR REPLACE INTO kv(k,v) VALUES('loadfail_alert_at',?)").bind(String(now)));
        }
      } catch (e2) { ctx.out.push('load-failure alert failed ' + e2); }
    }
    ctx.W.push(db.prepare("UPDATE kv SET v='0' WHERE k='lock'"));
    ctx.W.push(db.prepare("INSERT OR REPLACE INTO kv(k,v) VALUES('last_tick',?)").bind(String(now)));   // heartbeat for the daily health check
    if (ctx.ok) ctx.W.push(db.prepare("INSERT OR REPLACE INTO kv(k,v) VALUES('last_ok_tick',?)").bind(String(now)));   // only when the tick body completed (health check should watch this one)
    await db.batch(ctx.W);
  }
  return ctx.out;
}

// ---------- inbox onboarding (the operator signs in + Accept; code is exchanged server-side inside Mailbox's 2-minute window) ----------
const CATCH = 'https://oauth-catch.your-subdomain.workers.dev';
const SCOPES = 'ProviderMail.accounts.READ,ProviderMail.messages.ALL,ProviderMail.folders.READ';
async function hmac(key, msg) { const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return b64u(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)))); }
async function signState(env, o) { const p = b64uStr(JSON.stringify(o)); return `seq.${p}.${await hmac(env.ADMIN_KEY, p)}`; }
async function readState(env, t) {
  const [pre, p, sig] = String(t || '').split('.');
  if (pre !== 'seq' || !p || sig !== await hmac(env.ADMIN_KEY, p)) return null;
  const o = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/'))); return o.exp > Date.now() ? o : null;
}
const page = (title, msg, ok = true) => new Response(`<!doctype html><meta name=viewport content="width=device-width"><body style="font:17px system-ui;padding:32px;max-width:560px;margin:auto"><h2 style="color:${ok ? '#14532d' : '#7f1d1d'}">${title}</h2><p>${msg}</p></body>`, { headers: { 'content-type': 'text/html' } });
async function oauthStart(env, u) {
  const o = await readState(env, u.searchParams.get('t')); if (!o) return page('Link expired', 'Ask Claude for a fresh link.', false);
  const cfg = zcfg(env);
  const q = new URLSearchParams({ scope: SCOPES, client_id: appOf(cfg, o.app).client_id, response_type: 'code', access_type: 'offline', prompt: 'consent', redirect_uri: CATCH, state: u.searchParams.get('t') });
  return Response.redirect(`${ZACC}/oauth/v2/auth?${q}`, 302);
}
async function oauthCallback(env, u) {
  try { return await oauthCallbackInner(env, u); } catch (e) { return page('Not connected', 'Error: ' + String(e && e.message || e).replace(/[<>]/g, '').slice(0, 300), false); }
}
async function oauthCallbackInner(env, u) {
  const o = await readState(env, u.searchParams.get('state')); if (!o) return page('Link expired', 'Ask Claude for a fresh link.', false);
  if (u.searchParams.get('error')) return page('Not connected', 'Mailbox said: ' + u.searchParams.get('error').replace(/[<>]/g, ''), false);
  const cfg = zcfg(env), server = u.searchParams.get('accounts-server') || ZACC;
  if (!/^https:\/\/accounts\.mailbox\.(com|eu|in|com\.au|jp|ca)$/.test(server)) return page('Not connected', 'Unexpected Mailbox server.', false);
  const tr = await fetch(server + '/oauth/v2/token', { method: 'POST', body: new URLSearchParams({ code: u.searchParams.get('code') || '', client_id: appOf(cfg, o.app).client_id, client_secret: appOf(cfg, o.app).client_secret, grant_type: 'authorization_code', redirect_uri: CATCH }) });
  const td = await tr.json().catch(() => ({}));
  if (!td.refresh_token) return page('Not connected', `Mailbox token exchange failed (${td.error || tr.status}). Open the link again.`, false);
  const ar = await fetch(ZAPI + '/accounts', { headers: { Authorization: 'Mailbox-oauthtoken ' + td.access_token } }); const ad = await ar.json().catch(() => ({}));
  const accts = Array.isArray(ad.data) ? ad.data : [], a = accts.find(x => lc(x.primaryEmailAddress) === o.email || (x.emailAddress || []).some(e => lc(e.mailId) === o.email));
  if (!accts.length) return page('Mailbox not ready', `Mailbox has no mailbox for this sign-in yet (${(ad.data && (ad.data.errorCode || ad.data.moreInfo)) || ar.status}). Wait a minute and open the link again.`, false);
  if (!a) return page('Wrong mailbox', `You signed in as ${accts.map(x => x.primaryEmailAddress).join(', ') || 'an unknown account'}, but this link is for <b>${o.email}</b>. Open a private window, sign in as ${o.email}, and open the link again.`, false);
  const now = Date.now(), db = env.DB;
  await db.batch([
    db.prepare('INSERT OR REPLACE INTO box_creds(email,refresh_token,account_id,added_at,app) VALUES(?,?,?,?,?)').bind(o.email, td.refresh_token, String(a.accountId), new Date(now).toISOString(), o.app || null),
    db.prepare("INSERT OR IGNORE INTO boxes(email,lane,warm_only,start,ramp_step,step_days,strikes,parked,poll_since) VALUES(?,?,?,?,0,0,'[]',0,?)").bind(o.email, o.lane, o.warm_only ? 1 : 0, dayIn(ET, now), now),
    db.prepare('INSERT INTO events(at,kind,box,detail) VALUES(?,?,?,?)').bind(now, 'box_added', o.email, `lane ${o.lane}${o.warm_only ? ', warm only' : ''}; outgoingBlocked=${!!a.outgoingBlocked}`)]);
  return page('Connected', `<b>${o.email}</b> is now in the sequencer (${o.warm_only ? 'warm inquiries only' : o.lane}), starting at 3 a day. You can close this tab.`);
}

// ---------- admin ----------
function lint(p, recentSh, maxSteps = 4) {
  const errs = [], steps = p.steps || [];
  if (!steps.length) errs.push('no steps');
  steps.forEach((s, i) => {
    const w = words(s.body || ''), link = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|edu|gov|io|co|ai|dev|app|biz|info|shop|store|online|site|website|studio|salon|cafe|restaurant|bar|pub|fitness|clinic|dental|health|beauty|hair|law|legal|design|agency|club|life|live|world|xyz|me|tv|[a-z]{2})(\.[a-z]{2})?\b)/i.test((s.subject || '') + '\n' + (s.body || ''));   // r30 (27 Oct): every country TLD (.pt .uk .ie .es ...) and common new TLDs, subject included
    if (i === 0 && /^\s*re\s*:/i.test(s.subject || '')) errs.push('step 1 subject starts with Re:');
    if (i === 0 && link) errs.push('link in step 1');
    const all = (s.subject || '') + '\n' + (s.body || '');
    if (/\{\{|\}\}|\{\s*[a-z][a-z_ ]{1,30}\}|\[(first ?name|name|company|city|role|title)\]|<(first|name|company)>|%[a-z_]+%|\bundefined\b|\bNaN\b|\[object object\]/i.test(all)) errs.push(`step ${i + 1} has an unfilled placeholder`);
    if (/\b(free|guarantee[d]?|risk[- ]free|act now|click here|limited time|100%|no obligation|winner|cash|\$\$+|urgent|buy now|special offer|best price|cheap)\b/i.test(all)) errs.push(`step ${i + 1} has spam-trigger wording`);
    if (/!{2,}|\b[A-Z]{5,}\b/.test(all.replace(/\b(LLC|USA|HVAC|CRM|SEO|HIPAA|PDF|GDPR)\b/g, ''))) errs.push(`step ${i + 1} has shouting (caps or !!)`);
    if ((s.body || '').split('!').length - 1 > 1) errs.push(`step ${i + 1} has more than one exclamation mark`);
    if (p.lane !== 'warm' && (STOP_RX.test(all) || COMPLAINT_RX.test(all) || /\b(garant\w*|spam)\b/i.test(all))) errs.push(`step ${i + 1} contains a word the reply classifier treats as stop/complaint (it comes back quoted in replies)`);
    if (p.lane !== 'warm' && /(^|\n)[^\n]{0,40}\balex( operator)?\b[^\n]*(\n\s*(branda websites|the brand c|founder,? brandb))?\s*$/i.test((s.body || '').trim())) errs.push(`step ${i + 1} ends with a sign-off (the footer signs as Alex Operator, ${p.lane === 'brandb' ? 'Founder, BrandB' : isCoach(p) ? 'Brand C' : 'Brand A Websites'})`);
    if (p.lane !== 'warm') {   // 2026-11-05 the operator: no word cap on bodies
      const sw = words(s.subject || '');
      if (i === 0 && (sw < 2 || sw > 6)) errs.push(`subject ${sw} words (2-6)`);
      if (i === 0 && w < 50) errs.push(`step 1 body ${w} words (min 50)`);
      if (i > 0 && w < 15) errs.push(`step ${i + 1} body ${w} words (min 15)`);
    }
    const sh = shingles(s.body || ''); for (const o of recentSh) if (jaccard(sh, o) > 0.8) { errs.push(`step ${i + 1} too similar to another body`); break; }
    recentSh.push(sh);
  });
  if (p.lane === 'brandb') steps.forEach((s, i) => {
    const all = (s.subject || '') + '\n' + (s.body || '');
    if (/[\u2013\u2014]/.test(all)) errs.push(`step ${i + 1} has an em or en dash (BrandB copy rule)`);
    if (/\b(end[- ]to[- ]end|zero[- ]knowledge)\b/i.test(all)) errs.push(`step ${i + 1} claims end-to-end or zero-knowledge (never claimed for BrandB)`);
    if (/\bconflicts?(\s+of\s+interest)?\s+checks?\b/i.test(all)) errs.push(`step ${i + 1} mentions conflict checks (never mentioned)`);
    if (/\b(we|brandb|the (platform|app))\s+(will\s+)?(match|matches|matched|assign|assigns|assigned|recommend|recommends|recommended)\b/i.test(all)) errs.push(`step ${i + 1} says the platform matches, assigns or recommends attorneys (never said)`);
  });
  if (steps.length > maxSteps) errs.push(`max ${maxSteps} steps`);   // r30: production cap from kv.max_steps (the operator: 2 touches, never 3)
  if (p.lane === 'warm' && steps.length > 1) errs.push('warm inquiries are one email');
  return errs;
}
async function enrol(env, body) {
  const now = Date.now(), ctx = new Ctx(env, now); const S = await loadState(ctx);
  const recent = await env.DB.prepare('SELECT body FROM steps WHERE email IN (SELECT email FROM prospects WHERE created_at > ?)').bind(new Date(now - 14 * DAY).toISOString()).all();
  const recentSh = recent.results.map(r => shingles(r.body)), res = [];
  if ((body.prospects || []).length > 8) res.push({ warning: `only the first 8 of ${body.prospects.length} prospects were processed; enrol the rest in another call` });
  for (const raw of (body.prospects || []).slice(0, 8)) {
    const p = { ...raw, email: lc(raw.email) }, why = [];
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(p.email)) why.push('bad address');
    if (!['warm', ...COLD_LANES].includes(p.lane)) why.push('lane must be warm, branda or brandb');
    p.country = String(p.country || (STATE_TZ[(p.state || '').toUpperCase()] ? 'US' : '')).toUpperCase();
    if (p.lane === 'brandb' && p.country && p.country !== 'US') why.push('brandb cold is US only (the footer and hours are US)');
    if (isBrandC(p) && p.country && p.country !== 'US') why.push('coach batches are US only (Brand C footer is the US one)');
    if (COLD_LANES.includes(p.lane)) {
      const cc = p.country;   // country decides time zone, holidays and footer; no country is refused (the operator, 21 Oct 2026)
      if (!cc) why.push('cold needs country (ISO code) or a US state');
      else if (cc === 'CA' && !p.tz && !CA_TZ[(p.state || '').toUpperCase()]) why.push('CA: province code (state) or tz required');
      else if (cc !== 'US' && cc !== 'CA' && !COUNTRY_TZ[cc]) why.push(`${cc}: unknown country code (use ISO 3166, e.g. GB not UK, GR not EL); add it to COUNTRY_TZ and the holiday list first`);
      if (cc === 'US' && !p.tz && !STATE_TZ[(p.state || '').toUpperCase()]) why.push('cold needs the prospect state or tz (sends go in their local business hours)');
    }
    if (p.lane === 'branda' && GDPR_CC.has(p.country) && !p.company && (FREEMAIL.has(dom(p.email)) || MS_CONSUMER.has(dom(p.email)))) why.push('company required for a freemail address (the footer names the company)');
    if (p.lane === 'branda' && GDPR_CC.has(p.country) && S.kv.privacy_live === '1' && !p.source_url) why.push('source_url required in a GDPR country (the privacy notice cites where the address was found)');
    if (p.tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: p.tz }); } catch { why.push(`unknown time zone '${p.tz}' (use IANA, e.g. America/Chicago)`); } }
    if (suppressed(S, p.email, now)) why.push('suppressed');
    for (const [k, v] of Object.entries(S.kv)) if (k.startsWith('pend:')) { let x = null; try { x = JSON.parse(v); } catch { } if (!x) continue; const ds = [x.email, x.from].filter(Boolean).map(dom).filter(d => !FREEMAIL.has(d) && !MS_CONSUMER.has(d)), co0 = p.company ? lc(p.company) : null;   // round 22a: a company whose stop is pending (3-day wait) is held: no new address there
      if (ds.includes(dom(p.email)) || (co0 && x.company && lc(x.company) === co0)) { why.push(`company stop pending (${x.kind} from ${x.from}): held until it applies or the operator undoes it`); break; } }
    { const co = p.company ? lc(p.company) : (FREEMAIL.has(dom(p.email)) || MS_CONSUMER.has(dom(p.email)) ? null : dom(p.email)); if (co && S.supp['co:' + co]) why.push(`company asked to stop (${S.supp['co:' + co].reason})`); }
    const exist = await env.DB.prepare('SELECT status FROM prospects WHERE email=?').bind(p.email).first(); if (exist) why.push('already enrolled (' + exist.status + ')');
    if (p.box) { const b = S.boxes[p.box]; if (!b) why.push('unknown box'); else if ((b.warm_only || b.cold_off) && p.lane !== 'warm') why.push('box takes warm only'); }
    why.push(...lint(p, recentSh, Math.min(4, +(S.kv.max_steps || 4))));
    let mx = p.mx, verify = p.verify, vat = p.verified_at;
    if (!why.length) { mx = await mxClass(ctx, p.email); if (mx === 'microsoft' && S.kv.ms_open !== '1') why.push('microsoft-hosted'); if (mx === 'none') why.push('no MX'); if (mx === 'error') why.push('DNS lookup failed, enrol again'); }
    if (!why.length && !(verify && vat)) { verify = await verifyAddr(ctx, p.email); vat = new Date(now).toISOString(); }
    if (!why.length && !['ok', 'catch_all'].includes(verify)) why.push('Bouncer: ' + verify);
    if (why.length) { res.push({ email: p.email, rejected: why }); continue; }
    const st0 = (p.state || '').toUpperCase(), tz = p.tz || (p.country === 'CA' ? CA_TZ[st0] : p.country && p.country !== 'US' ? COUNTRY_TZ[p.country] : STATE_TZ[st0]) || null, company = p.company ? lc(p.company) : (FREEMAIL.has(dom(p.email)) ? null : dom(p.email));
    const st = [env.DB.prepare('INSERT INTO prospects(email,lane,batch,company,tz,mx,verify,verified_at,status,box,step,nsteps,created_at,status_at,country,source_url,display_company) VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)')
      .bind(p.email, p.lane, p.batch || '', company, tz, mx, verify, vat, 'draft', p.box || null, p.steps.length, new Date(now).toISOString(), new Date(now).toISOString(), p.country || 'US', p.source_url || null, p.company || null)];
    p.steps.forEach((s, i) => st.push(env.DB.prepare('INSERT INTO steps(email,step,subject,body) VALUES(?,?,?,?)').bind(p.email, i, s.subject, s.body)));
    await env.DB.batch(st); res.push({ email: p.email, queued: true, verify, mx, tz });
  }
  return res;
}
async function admin(req, env, path) {
  const db = env.DB; let body = {};
  if (req.method === 'POST') { const raw = await req.text(); if (raw.trim()) { try { body = JSON.parse(raw); } catch { return json({ error: 'body is not valid JSON: nothing changed' }, 400); } } if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'body must be a JSON object' }, 400); }
  const ctxFor = async () => { const c = new Ctx(env, Date.now()); c.version = env.CF_VERSION_METADATA?.id || 'dev'; await loadState(c); return c; };
  switch (path) {
    case 'status': { const c = await ctxFor(); return new Response(statusText(c, dayIn(ET, c.now)) + '\n\nToday:\n' + c.S.slots.filter(s => s.et_day === dayIn(ET, c.now)).map(s => `${new Date(s.due_at).toISOString().slice(11, 16)}Z ${s.box} -> ${s.email} ${s.kind}/${s.step} ${s.status}`).join('\n')); }
    case 'tick': return json(await tick(env, { force: true }));
    case 'oauthlink': { if (body.app && !(zcfg(env).apps || {})[body.app]) return json({ error: `unknown app ${body.app}` }, 400); const t = await signState(env, { email: lc(body.email), lane: body.lane || 'brandb', warm_only: body.warm_only ?? 1, app: body.app || null, exp: Date.now() + 2 * DAY }); return json({ url: `https://branda-sequencer.your-subdomain.workers.dev/oauth/start?t=${t}` }); }
    case 'preview': { const at = body.at ? Date.parse(body.at) : Date.now(); const c = new Ctx(env, at); c.version = 'preview'; c.preview = true; await loadState(c); const d = dayIn(ET, at); rollover(c, d); await plan(c, d); return json({ day: d, sendingDay: isSendingDay(d), out: c.out }); }
    case 'enrol': return json(await enrol(env, body));
    case 'approve': { const r = await db.prepare("UPDATE prospects SET status='active', status_at=? WHERE batch=? AND status='draft'").bind(new Date().toISOString(), body.batch).run(); return json({ approved: r.meta.changes }); }
    case 'readmsg': {   // read-only: full text of an inbound message (body: {mid}); the operator 13 Nov: always read the whole email before drafting a reply
      const c = await ctxFor(); const ib = await db.prepare('SELECT * FROM inbound WHERE mid=?').bind(String(body.mid || '')).first();
      if (!ib) return json({ error: 'unknown inbound mid' }, 404);
      const aid = aidOf(c, ib.box); let fid = null;
      for (let pg = 0; pg < 5 && !fid; pg++) { const r = await zapi(c, ib.box, 'GET', `/accounts/${aid}/messages/view?limit=50&start=${50 * pg + 1}`); const m = (Array.isArray(r.d && r.d.data) ? r.d.data : []).find(x => String(x.messageId) === String(ib.mid)); if (m) fid = m.folderId; }
      if (!fid) return json({ error: 'message not found in the first 250 of the inbox' }, 404);
      const cc = await zapi(c, ib.box, 'GET', `/accounts/${aid}/folders/${fid}/messages/${ib.mid}/content`);
      return json({ from: ib.from_addr, box: ib.box, subject: ib.subject, status: cc.s, content: cc.d && cc.d.data && cc.d.data.content });
    }
    case 'reply': {   // the operator's answer to a prospect, sent from the inbox that holds the thread (body: {mid, text})
      const c = await ctxFor(); const ib = await db.prepare('SELECT * FROM inbound WHERE mid=?').bind(String(body.mid || '')).first();
      if (!ib) return json({ error: 'unknown inbound mid' }, 404);
      if (!body.text || String(body.text).trim().length < 2) return json({ error: 'empty text' }, 400);
      { const to = lc(ib.from_addr), opt = [to, '@' + dom(to)].map(k => c.S.supp[k]).find(x => x && !x.until && OPT_REASON(x.reason));   // "Reply stop and I won't email again" covers the operator's manual answers too
        if (!to) return json({ error: 'sender erased (opted out): nothing sent' }, 409);
        if ((opt || ['stop', 'complaint'].includes(ib.kind)) && !body.force) return json({ error: `recipient opted out (${opt ? opt.reason : ib.kind}): nothing sent; force:true only for a one-line removal confirmation or the answer to a data request`, to }, 409); }
      const subj = /^re\s*:/i.test(ib.subject || '') ? ib.subject : 'Re: ' + (ib.subject || '');
      const r = await zapi(c, ib.box, 'POST', `/accounts/${aidOf(c, ib.box)}/messages/${ib.mid}`, { fromAddress: `Alex Operator <${ib.box}>`, toAddress: ib.from_addr, subject: subj, content: String(body.text).trim(), mailFormat: 'plaintext', action: 'reply' });
      if (r.s === 200 || r.s === 201) { c.q('INSERT INTO sends(box,to_addr,at,kind,et_day) VALUES(?,?,?,?,?)', ib.box, ib.from_addr, c.now, 'reply', dayIn(ET, c.now)); c.ev('manual_reply', ib.box, ib.from_addr, String(body.text).slice(0, 200)); }
      if (c.W.length) await db.batch(c.W);
      return json({ status: r.s, to: ib.from_addr, from: ib.box, detail: r.s === 200 || r.s === 201 ? 'sent' : r.text.slice(0, 300) });
    }
    case 'stop': {   // the operator ties an opt-out to a prospect (body: {email}): stopped + suppressed now, company held like any stop (blocked after the wait)
      const c = await ctxFor(), e = lc(body.email || ''), p = c.S.P[e] || (await db.prepare('SELECT * FROM prospects WHERE email=?').bind(e).first());
      if (!p) { suppress(c, e, 'stop (by the operator)'); if (c.W.length) await db.batch(c.W); return json({ stopped: e, prospect: false }); }
      c.S.P[e] = p; suppress(c, e, 'stop (by the operator)'); setP(c, p, { status: 'stopped', note: 'stopped by the operator' }); cancelSlots(c, e, 'stop by the operator');
      const also = companyHold(c, p, e, 'stop'); c.ev('stop', null, e, 'stopped by the operator' + also, 0); if (c.W.length) await db.batch(c.W); return json({ stopped: e, detail: also });
    }
    case 'confirm': {   // apply a pending company stop now (body: {email})
      const c = await ctxFor(), e = lc(body.email || ''); if (!c.S.kv['pend:' + e]) return json({ error: 'no pending company stop for ' + e }, 404);
      const done = applyPending(c, e); if (c.W.length) await db.batch(c.W); return json({ confirmed: done });
    }
    case 'undo': {   // a reply misread as a stop/complaint (body: {email}): un-suppress the person, release the held colleagues, drop the pending company stop
      const e = lc(body.email || ''); if (!e) return json({ error: 'email required' }, 400);
      const pend = (await db.prepare('SELECT v FROM kv WHERE k=?').bind('pend:' + e).first())?.v; let x = null; try { x = JSON.parse(pend || 'null'); } catch { }
      const from = x?.from || e, at = new Date().toISOString();
      const held = (await db.prepare("SELECT email, note FROM prospects WHERE status='company_paused' AND note LIKE ?").bind(`held: % from ${from} (company stop pending%`).all()).results;
      const st = [db.prepare("DELETE FROM suppression WHERE email IN (?,?) AND until IS NULL AND (reason LIKE 'stop%' OR reason LIKE 'complaint%')").bind(e, from),
        db.prepare("UPDATE prospects SET status='replied', status_at=?, note=? WHERE email=? AND status='stopped'").bind(at, 'undo by the operator: reply was not an opt-out', e),
        db.prepare('DELETE FROM kv WHERE k=?').bind('pend:' + e),
        db.prepare("UPDATE inbound SET kind='reply' WHERE from_addr IN (?,?) AND kind IN ('stop','complaint')").bind(e, from),   // round 22a: the operator answers the misread reply with /admin/reply (it refused kind stop/complaint)
        db.prepare('INSERT INTO events(at,kind,target,detail,alert) VALUES(?,?,?,?,0)').bind(Date.now(), 'undo', e, `undo: ${e} un-suppressed, ${held.length} colleague(s) kept paused as colleagues of a live conversation${x ? '' : ' (no pending company stop: if it was already applied, its @domain / co: rows stay; remove them with exec)'}`)];
      // the reply was a real conversation: colleagues stay paused while it is live (they are resumed by hand, like any colleague of a replier)
      for (const h of held) st.push(db.prepare('UPDATE prospects SET note=? WHERE email=?').bind('colleague replied: ' + e + ' (undo of a misread stop)', h.email));
      await db.batch(st); return json({ undone: e, colleagues_kept_paused: held.map(h => h.email), pending_cleared: !!x });
    }
    case 'kill': {
      if (body.lane || new URL(req.url).searchParams.get('lane')) {   // the BrandB lane on its own: POST {"lane":"brandb","on":false} arms it, {"on":true} holds it (the global stop still rules both)
        const lane = String(body.lane || new URL(req.url).searchParams.get('lane')); if (lane !== 'brandb') return json({ error: 'only the brandb lane has its own switch' }, 400);
        const v = (await db.prepare("SELECT v FROM kv WHERE k='kill_brandb'").first())?.v, held = laneHeld({ kill_brandb: v }, lane);
        if (req.method !== 'POST') return json({ lane, held, reason: v || 'not armed' });
        if (body.on !== true && body.on !== false) return json({ error: 'POST {"lane":"brandb","on":true} to hold or {"on":false} to arm: nothing changed', held }, 400);
        if (body.on === false && /^auto: complaint/.test(v || '') && !body.force) return json({ error: 'held after a complaint: re-arming needs force:true', reason: v }, 409);
        const nv = body.on ? (body.reason || 'manual') : 'off';
        await db.batch([db.prepare("INSERT OR REPLACE INTO kv(k,v) VALUES('kill_brandb',?)").bind(nv), ...(body.on ? [] : [db.prepare("INSERT OR REPLACE INTO kv(k,v) VALUES('kill_brandb_lifted_at',?)").bind(String(Date.now()))]), db.prepare('INSERT INTO events(at,kind,detail,alert) VALUES(?,?,?,0)').bind(Date.now(), body.on ? 'lane_hold' : 'lane_arm', `brandb cold ${body.on ? 'held: ' + nv : 'armed'} (was: ${v || 'not armed'})`)]);
        return json({ lane, held: !!body.on, was: v || 'not armed' });
      }
      const cur = (await db.prepare("SELECT v FROM kv WHERE k='kill'").first())?.v || 'off', on = cur !== 'off' && cur !== '0';
      if (req.method !== 'POST') return json({ kill: on ? 'on' : 'off', reason: cur, note: 'POST {"on":true} to stop or {"on":false} to resume' });   // a GET (status check, link preview) never lifts a stop
      if (body.on === true) { if (!on) await db.prepare("UPDATE kv SET v=? WHERE k='kill'").bind(body.reason || 'manual').run(); return json({ kill: 'on', reason: on ? cur : (body.reason || 'manual') }); }   // never overwrite an automatic stop's reason
      if (body.on !== false) return json({ error: 'POST {"on":true} to stop or {"on":false} to resume: nothing changed', kill: on ? cur : 'off' }, 400);   // a typo in a stop request must never resume sending
      if (/^auto: complaint/.test(cur) && !body.force) return json({ error: 'stopped after a complaint: resume needs force:true', kill: cur }, 409);
      await db.batch([db.prepare("UPDATE kv SET v='off' WHERE k='kill'"), db.prepare("INSERT OR REPLACE INTO kv(k,v) VALUES('kill_lifted_at',?)").bind(String(Date.now())), db.prepare('INSERT INTO events(at,kind,detail,alert) VALUES(?,?,?,0)').bind(Date.now(), 'resume', 'kill off (was: ' + cur + ')')]);
      return json({ kill: 'off', was: cur });
    }
    case 'boxcold': {   // turn a BrandB inbox to cold (body: {box, cold:true}) or back to warm-only ({cold:false}); it starts at the bottom of the ramp
      const b = await db.prepare('SELECT email, lane, warm_only FROM boxes WHERE email=?').bind(lc(body.box || '')).first();
      if (!b) return json({ error: 'unknown box' }, 404);
      if (b.lane !== 'brandb') return json({ error: 'only BrandB inboxes are switched here' }, 400);
      if (body.cold !== true && body.cold !== false) return json({ error: 'cold must be true or false: nothing changed' }, 400);
      await db.batch([db.prepare('UPDATE boxes SET warm_only=?, ramp_step=CASE WHEN ? THEN 0 ELSE ramp_step END, step_days=CASE WHEN ? THEN 0 ELSE step_days END WHERE email=?').bind(body.cold ? 0 : 1, body.cold && b.warm_only ? 1 : 0, body.cold && b.warm_only ? 1 : 0, b.email),
        db.prepare('INSERT INTO events(at,kind,box,detail,alert) VALUES(?,?,?,?,0)').bind(Date.now(), 'box_cold', b.email, body.cold ? 'switched to cold (BrandB lane), ramp from 2 a day' : 'switched to warm-only')]);
      return json({ box: b.email, cold: !!body.cold });
    }
    case 'live': await db.batch([db.prepare("UPDATE kv SET v='live' WHERE k='mode'"), db.prepare("UPDATE kv SET v=? WHERE k='live_version'").bind(env.CF_VERSION_METADATA?.id || 'dev')]); return json({ mode: 'live', version: env.CF_VERSION_METADATA?.id });
    case 'dry': await db.prepare("UPDATE kv SET v='dry' WHERE k='mode'").run(); return json({ mode: 'dry' });
    case 'pause': await db.prepare('UPDATE boxes SET paused_until=?, pause_reason=? WHERE email=?').bind(new Date(Date.now() + (body.days || 1) * DAY).toISOString(), body.reason || 'manual', body.box).run(); return json({ ok: 1 });
    case 'resume': await db.batch([db.prepare("UPDATE boxes SET paused_until=NULL, pause_reason=NULL WHERE email=?").bind(body.box), db.prepare('INSERT OR REPLACE INTO kv(k,v) VALUES(?,?)').bind('resumed_at:' + lc(body.box), String(Date.now()))]); return json({ ok: 1 });
    case 'set': { const ok = ['ms_open'].includes(body.k); if (ok) await db.prepare('INSERT OR REPLACE INTO kv VALUES(?,?)').bind(body.k, String(body.v)).run(); return json({ ok }); }
    case 'sql': { const q = String(body.q || ''); if (!/^\s*select\b/i.test(q) || /;\s*\S/.test(q)) return json({ error: 'select only' }, 400); return json((await db.prepare(q).all()).results); }
    case 'exec': { if (!body.confirm) return json({ error: 'confirm required' }, 400); const r = await db.batch((body.statements || []).map(s => db.prepare(s.q).bind(...(s.a || [])))); return json(r.map(x => x.meta.changes)); }
    case 'testalert': { const c = await ctxFor(); await gmailSend(c, 'Sequencer test alert', 'If you can read this, alerts and the daily digest reach you.\n\n' + statusText(c, dayIn(ET, c.now))); await db.batch(c.W.length ? c.W : [db.prepare('SELECT 1')]); return json({ sent: true }); }
    case 'digest': { const c = await ctxFor(); await digest(c, dayIn(ET, c.now)); if (c.W.length) await db.batch(c.W); return json({ sent: true }); }
    default: return json({ error: 'unknown' }, 404);
  }
}
function safeEq(a, b) { const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b); let d = x.length ^ y.length; for (let i = 0; i < y.length; i++) d |= (x[i % (x.length || 1)] || 0) ^ y[i]; return d === 0; }
export default {
  async scheduled(evt, env, c) { c.waitUntil(tick(env).then(o => o.length && console.log(o.join(' | ')))); },
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === '/oauth/start') return oauthStart(env, u);
    if (u.pathname === '/oauth/callback') return oauthCallback(env, u);
    if (!u.pathname.startsWith('/admin/')) return new Response('ok');
    if (!env.ADMIN_KEY || !safeEq(req.headers.get('authorization') || '', 'Bearer ' + env.ADMIN_KEY)) return new Response('no', { status: 401 });
    try { return await admin(req, env, u.pathname.slice(7)); } catch (e) { return json({ error: String(e.stack || e) }, 500); }
  }
};
