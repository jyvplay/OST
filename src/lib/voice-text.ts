/**
 * Fusion Voice text front-end (TT32). Original code: text normalisation, a hand-written lexicon, context-sensitive
 * letter-to-sound rules, stress assignment and vowel reduction → phrases of ARPAbet phones for voice-synth.ts.
 *
 * Phone symbols are ARPAbet (the same symbol set CMUdict uses, so the test suite can score these rules against CMUdict
 * as an independent oracle — nothing from CMUdict is shipped or read here).
 */
import type { Phrase, PhoneTok } from "./voice-synth";

// ---------------------------------------------------------------------------------------------------------------
// lexicon: words whose spelling the rules would get wrong, plus the Narrator's own vocabulary (transcribed by hand)

const LEX_SRC = `
a:AH0|an:AE1 N|the:DH AH0|of:AH1 V|to:T UW1|and:AE1 N D|or:AO1 R|is:IH1 Z|are:AA1 R|was:W AA1 Z|were:W ER1|be:B IY1
been:B IH1 N|being:B IY1 IH0 NG|have:HH AE1 V|has:HH AE1 Z|had:HH AE1 D|do:D UW1|does:D AH1 Z|done:D AH1 N|did:D IH1 D
you:Y UW1|your:Y AO1 R|yours:Y AO1 R Z|he:HH IY1|she:SH IY1|we:W IY1|me:M IY1|they:DH EY1|them:DH EH1 M|their:DH EH1 R
there:DH EH1 R|these:DH IY1 Z|those:DH OW1 Z|this:DH IH1 S|that:DH AE1 T|then:DH EH1 N|than:DH AE1 N|thus:DH AH1 S
with:W IH1 DH|without:W IH0 DH AW1 T|what:W AH1 T|who:HH UW1|whom:HH UW1 M|whose:HH UW1 Z|where:W EH1 R|when:W EH1 N
why:W AY1|how:HH AW1|which:W IH1 CH|while:W AY1 L|from:F R AH1 M|for:F AO1 R|by:B AY1|my:M AY1|it:IH1 T|its:IH1 T S
in:IH1 N|on:AA1 N|at:AE1 T|as:AE1 Z|if:IH1 F|so:S OW1|no:N OW1|not:N AA1 T|yes:Y EH1 S|all:AO1 L|any:EH1 N IY0
many:M EH1 N IY0|some:S AH1 M|come:K AH1 M|one:W AH1 N|once:W AH1 N S|only:OW1 N L IY0|other:AH1 DH ER0|into:IH1 N T UW0
onto:AA1 N T UW0|up:AH1 P|out:AW1 T|over:OW1 V ER0|under:AH1 N D ER0|again:AH0 G EH1 N|about:AH0 B AW1 T|above:AH0 B AH1 V
also:AO1 L S OW0|every:EH1 V R IY0|very:V EH1 R IY0|can:K AE1 N|could:K UH1 D|would:W UH1 D|should:SH UH1 D|will:W IH1 L
shall:SH AE1 L|may:M EY1|might:M AY1 T|must:M AH1 S T|one's:W AH1 N Z|two:T UW1|three:TH R IY1|four:F AO1 R|five:F AY1 V
six:S IH1 K S|seven:S EH1 V AH0 N|eight:EY1 T|nine:N AY1 N|ten:T EH1 N|eleven:IH0 L EH1 V AH0 N|twelve:T W EH1 L V
thirteen:TH ER1 T IY1 N|fifteen:F IH1 F T IY1 N|twenty:T W EH1 N T IY0|thirty:TH ER1 T IY0|forty:F AO1 R T IY0
fifty:F IH1 F T IY0|eighty:EY1 T IY0|hundred:HH AH1 N D R AH0 D|thousand:TH AW1 Z AH0 N D|million:M IH1 L Y AH0 N
billion:B IH1 L Y AH0 N|zero:Z IH1 R OW0|first:F ER1 S T|second:S EH1 K AH0 N D|third:TH ER1 D|point:P OY1 N T
percent:P ER0 S EH1 N T|minus:M AY1 N AH0 S|plus:P L AH1 S|dot:D AA1 T|slash:S L AE1 SH|dash:D AE1 SH|equals:IY1 K W AH0 L Z
button:B AH1 T AH0 N|buttons:B AH1 T AH0 N Z|link:L IH1 NG K|heading:HH EH1 D IH0 NG|level:L EH1 V AH0 L|checkbox:CH EH1 K B AA2 K S
checked:CH EH1 K T|unchecked:AH0 N CH EH1 K T|dialog:D AY1 AH0 L AO2 G|menu:M EH1 N Y UW0|window:W IH1 N D OW0
windows:W IH1 N D OW0 Z|settings:S EH1 T IH0 NG Z|search:S ER1 CH|close:K L OW1 Z|open:OW1 P AH0 N|file:F AY1 L|files:F AY1 L Z
folder:F OW1 L D ER0|selected:S AH0 L EH1 K T IH0 D|expanded:IH0 K S P AE1 N D IH0 D|collapsed:K AH0 L AE1 P S T
pressed:P R EH1 S T|disabled:D IH0 S EY1 B AH0 L D|required:R IY0 K W AY1 ER0 D|invalid:IH0 N V AE1 L IH0 D|readonly:R IY1 D OW1 N L IY0
read:R IY1 D|edit:EH1 D IH0 T|text:T EH1 K S T|field:F IY1 L D|list:L IH1 S T|item:AY1 T AH0 M|items:AY1 T AH0 M Z
image:IH1 M IH0 JH|images:IH1 M IH0 JH IH0 Z|graphic:G R AE1 F IH0 K|table:T EY1 B AH0 L|row:R OW1|column:K AA1 L AH0 M
cell:S EH1 L|region:R IY1 JH AH0 N|landmark:L AE1 N D M AA2 R K|navigation:N AE2 V AH0 G EY1 SH AH0 N|main:M EY1 N
banner:B AE1 N ER0|form:F AO1 R M|tab:T AE1 B|panel:P AE1 N AH0 L|toolbar:T UW1 L B AA2 R|slider:S L AY1 D ER0|combo:K AA1 M B OW0
spin:S P IH1 N|progress:P R AA1 G R EH2 S|separator:S EH1 P ER0 EY2 T ER0|radio:R EY1 D IY0 OW2|group:G R UW1 P|status:S T AE1 T AH0 S
alert:AH0 L ER1 T|tooltip:T UW1 L T IH2 P|document:D AA1 K Y AH0 M AH0 N T|article:AA1 R T IH0 K AH0 L|section:S EH1 K SH AH0 N
narrator:N EH1 R EY2 T ER0|fusion:F Y UW1 ZH AH0 N|shell:SH EH1 L|desktop:D EH1 S K T AA2 P|tabletop:T EY1 B AH0 L T AA2 P
wall:W AO1 L|walls:W AO1 L Z|floor:F L AO1 R|pinned:P IH1 N D|pile:P AY1 L|card:K AA1 R D|cards:K AA1 R D Z|dock:D AA1 K
taskbar:T AE1 S K B AA2 R|launcher:L AO1 N CH ER0|widget:W IH1 JH IH0 T|widgets:W IH1 JH IH0 T S|recent:R IY1 S AH0 N T
apps:AE1 P S|app:AE1 P|notes:N OW1 T S|note:N OW1 T|music:M Y UW1 Z IH0 K|video:V IH1 D IY0 OW2|videos:V IH1 D IY0 OW2 Z
maps:M AE1 P S|map:M AE1 P|calendar:K AE1 L AH0 N D ER0|photos:F OW1 T OW2 Z|terminal:T ER1 M IH0 N AH0 L|browser:B R AW1 Z ER0
contacts:K AA1 N T AE2 K T S|weather:W EH1 DH ER0|clock:K L AA1 K|camera:K AE1 M ER0 AH0|trash:T R AE1 SH|printer:P R IH1 N T ER0
network:N EH1 T W ER2 K|battery:B AE1 T ER0 IY0|volume:V AA1 L Y UW0 M|keyboard:K IY1 B AO2 R D|mail:M EY1 L|spotify:S P AA1 T IH0 F AY2
soundcloud:S AW1 N D K L AW2 D|youtube:Y UW1 T UW2 B|private:P R AY1 V AH0 T|privacy:P R AY1 V AH0 S IY0|theme:TH IY1 M
dark:D AA1 R K|light:L AY1 T|large:L AA1 R JH|small:S M AO1 L|on:AA1 N|off:AO1 F|new:N UW1|save:S EY1 V|saved:S EY1 V D
delete:D IH0 L IY1 T|cancel:K AE1 N S AH0 L|ok:OW2 K EY1|okay:OW2 K EY1|done:D AH1 N|back:B AE1 K|next:N EH1 K S T|previous:P R IY1 V IY0 AH0 S
start:S T AA1 R T|stop:S T AA1 P|play:P L EY1|pause:P AO1 Z|mute:M Y UW1 T|copy:K AA1 P IY0|paste:P EY1 S T|cut:K AH1 T
undo:AH0 N D UW1|redo:R IY0 D UW1|help:HH EH1 L P|user:Y UW1 Z ER0|account:AH0 K AW1 N T|password:P AE1 S W ER2 D
email:IY1 M EY2 L|online:AA1 N L AY2 N|offline:AO1 F L AY2 N|loading:L OW1 D IH0 NG|error:EH1 R ER0|warning:W AO1 R N IH0 NG
hello:HH AH0 L OW1|world:W ER1 L D|word:W ER1 D|words:W ER1 D Z|work:W ER1 K|people:P IY1 P AH0 L|said:S EH1 D|says:S EH1 Z
give:G IH1 V|live:L IH1 V|have:HH AE1 V|love:L AH1 V|move:M UW1 V|gone:G AO1 N|none:N AH1 N|own:OW1 N|know:N OW1|known:N OW1 N
show:SH OW1|shown:SH OW1 N|now:N AW1|down:D AW1 N|town:T AW1 N|great:G R EY1 T|break:B R EY1 K|head:HH EH1 D|dead:D EH1 D
ready:R EH1 D IY0|already:AO0 L R EH1 D IY0|instead:IH0 N S T EH1 D|bread:B R EH1 D|heavy:HH EH1 V IY0|early:ER1 L IY0
learn:L ER1 N|heart:HH AA1 R T|hour:AW1 ER0|our:AW1 ER0|four:F AO1 R|through:TH R UW1|though:DH OW1|thought:TH AO1 T
enough:IH0 N AH1 F|tough:T AH1 F|laugh:L AE1 F|could:K UH1 D|sure:SH UH1 R|busy:B IH1 Z IY0|business:B IH1 Z N AH0 S
build:B IH1 L D|built:B IH1 L T|guide:G AY1 D|guess:G EH1 S|eye:AY1|buy:B AY1|key:K IY1|keys:K IY1 Z|blue:B L UW1|true:T R UW1
again:AH0 G EH1 N|against:AH0 G EH1 N S T|answer:AE1 N S ER0|because:B IH0 K AH1 Z|before:B IH0 F AO1 R|after:AE1 F T ER0
between:B IH0 T W IY1 N|today:T AH0 D EY1|tomorrow:T AH0 M AA1 R OW0|yesterday:Y EH1 S T ER0 D EY2|minute:M IH1 N AH0 T
minutes:M IH1 N AH0 T S|seconds:S EH1 K AH0 N D Z|hours:AW1 ER0 Z|day:D EY1|days:D EY1 Z|week:W IY1 K|month:M AH1 N TH
year:Y IH1 R|years:Y IH1 R Z|time:T AY1 M|date:D EY1 T|am:AE1 M|pm:P IY1 EH1 M|ms:M IH1 L IY0 S EH2 K AH0 N D Z
women:W IH1 M AH0 N|woman:W UH1 M AH0 N|child:CH AY1 L D|children:CH IH1 L D R AH0 N|machine:M AH0 SH IY1 N|police:P AH0 L IY1 S
music's:M Y UW1 Z IH0 K S|quiet:K W AY1 AH0 T|science:S AY1 AH0 N S|idea:AY0 D IY1 AH0|ideas:AY0 D IY1 AH0 Z|area:EH1 R IY0 AH0
create:K R IY0 EY1 T|created:K R IY0 EY1 T IH0 D|install:IH0 N S T AO1 L|update:AH1 P D EY2 T|updated:AH1 P D EY2 T IH0 D
download:D AW1 N L OW2 D|upload:AH1 P L OW2 D|import:IH1 M P AO2 R T|export:EH1 K S P AO2 R T|record:R EH1 K ER0 D
object:AA1 B JH EH0 K T|present:P R EH1 Z AH0 N T|content:K AA1 N T EH0 N T|contents:K AA1 N T EH0 N T S|preview:P R IY1 V Y UW2
review:R IY0 V Y UW1|view:V Y UW1|views:V Y UW1 Z|focus:F OW1 K AH0 S|focused:F OW1 K AH0 S T|page:P EY1 JH|pages:P EY1 JH IH0 Z
fourteen:F AO1 R T IY1 N|sixteen:S IH1 K S T IY1 N|seventeen:S EH1 V AH0 N T IY1 N|eighteen:EY1 T IY1 N|nineteen:N AY1 N T IY1 N
sixty:S IH1 K S T IY0|seventy:S EH1 V AH0 N T IY0|ninety:N AY1 N T IY0|trillion:T R IH1 L Y AH0 N|fifth:F IH1 F TH|eighth:EY1 T TH
ninth:N AY1 N TH|twelfth:T W EH1 L F TH|dollar:D AA1 L ER0|dollars:D AA1 L ER0 Z|degrees:D IH0 G R IY1 Z|times:T AY1 M Z
self:S EH1 L F|selves:S EH1 L V Z|body:B AA1 D IY0|thing:TH IH1 NG|things:TH IH1 NG Z|way:W EY1|ways:W EY1 Z|ever:EH1 V ER0
him:HH IH1 M|her:HH ER1|whole:HH OW1 L|less:L EH1 S|more:M AO1 R|most:M OW1 S T|ball:B AO1 L|foot:F UH1 T|out:AW1 T
oh:OW1|hey:HH EY1|yeah:Y AE1|euros:Y UH1 R OW0 Z|pounds:P AW1 N D Z|greater:G R EY1 T ER0|number:N AH1 M B ER0
of:AH1 V|everything:EH1 V R IY0 TH IH2 NG|something:S AH1 M TH IH0 NG|nothing:N AH1 TH IH0 NG|anything:EH1 N IY0 TH IH2 NG
`;

const LEX: Map<string, string[]> = new Map();
for (const e of LEX_SRC.split(/[|\n]/)) { const s = e.trim(); if (!s) continue; const i = s.indexOf(":"); LEX.set(s.slice(0, i), s.slice(i + 1).split(" ")); }
export const lexiconSize = () => LEX.size;
export const inLexicon = (w: string) => LEX.has(w);

const LETTER: Record<string, string> = {
  a: "EY1", b: "B IY1", c: "S IY1", d: "D IY1", e: "IY1", f: "EH1 F", g: "JH IY1", h: "EY1 CH", i: "AY1", j: "JH EY1",
  k: "K EY1", l: "EH1 L", m: "EH1 M", n: "EH1 N", o: "OW1", p: "P IY1", q: "K Y UW1", r: "AA1 R", s: "EH1 S", t: "T IY1",
  u: "Y UW1", v: "V IY1", w: "D AH1 B AH0 L Y UW0", x: "EH1 K S", y: "W AY1", z: "Z IY1",
};

// ---------------------------------------------------------------------------------------------------------------
// letter-to-sound rules: [left context, letters, right context, phones]. Contexts are regular expressions over the
// spelling: left is matched against the text before (anchored at its end), right against the text after (anchored at
// its start). Macros: C = one consonant letter, V = one vowel letter, S = the "magic e" endings. Vowels come out
// without stress digits; stress is assigned afterwards. Rules are tried in order; the first match wins.

type Rule = [RegExp | null, string, RegExp | null, string];
const MAC: Record<string, string> = { C: "[bcdfghjklmnpqrstvwxz]", V: "[aeiouy]", S: "(?:e|es|ed|er|ers|ely|ement|eless|eful|ing)?$" };
const rx = (s: string, side: "l" | "r") => (s ? new RegExp(side === "l" ? `(?:${s.replace(/[CVS]/g, (m) => MAC[m])})$` : `^(?:${s.replace(/[CVS]/g, (m) => MAC[m])})`) : null);
/** compact rule source: "left|letters|right=PHONES" (PHONES may be empty for a silent letter) */
const R = (src: string): Rule[] => src.trim().split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
  const eq = l.lastIndexOf("="), ctx = l.slice(0, eq), ph = l.slice(eq + 1);
  // the letters field is the first "|letters|" whose left side has balanced parentheses (contexts use | themselves)
  const re = /\|([a-z]+)\|/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ctx))) {
    const left = ctx.slice(0, m.index);
    if ((left.match(/\(/g) ?? []).length === (left.match(/\)/g) ?? []).length) return [rx(left, "l"), m[1], rx(ctx.slice(m.index + m[0].length), "r"), ph.trim()];
    re.lastIndex = m.index + 1;
  }
  throw new Error(`bad letter-to-sound rule: ${l}`);
});

/** first vowel of the word (no vowel letter before) — the magic-e + suffix pattern only applies there */
const FIRST = "^[^aeiouy]*";

const RULES: Record<string, Rule[]> = {
  a: R(`
    |augh|t=AO
    |au|=AO
    |aw|=AO
    |ai|r=EH
    |ai|=AI
    |ay|=EY
    w|ar|=AO R
    ^|a|w[aeiouy]=AH
    [a-z]{3,}|a|ble$=AH
    |ar|e$=EH R
    |arr|=AE R
    |ar|V=EH R
    |ar|=AA R
    |all|=AO L
    |al|k=AO
    |al|f$=AE
    |al|m$=AA
    ^|al|=AO L
    w|a|(?:ter|lk|ll)=AO
    w|a|(?:s|t|tch|nt|nd|sh)=AA
    qu|a|=AA
    |a|tions?$=EY
    |a|sion=EY
    |a|nge=EY
    |a|ste$=EY
    |a|[bfgpt]le$=EY
    ${FIRST}|a|C(?:e|es|ed|er|ers|ing|ely|y|en|or)$=EY
    |a|Ce$=EY
    |a|$=AH
    |a|=AE
  `),
  b: R(`
    m|b|$=
    |bb|=B
    |b|=B
  `),
  c: R(`
    ^s|ch|=K
    ^te|ch|=K
    |chr|=K R
    |ch|=CH
    |ck|=K
    |cc|[eiy]=K S
    |cc|=K
    |ci|[ao]=SH
    s|c|[eiy]=
    |c|[eiy]=S
    |c|=K
  `),
  d: R(`
    |dd|=D
    |dg|e=JH
    [aeiouy].*[td]|ed|$=IH D
    [aeiouy].*(?:[pkfsx]|sh|ch)|ed|$=T
    [aeiouy].*C|ed|$=D
    |d|=D
  `),
  e: R(`
    |eau|=OW
    |ee|r=IH R
    |ee|=IY
    |ea|(?:lth|sure|ther|vy|nt$|th$|d$)=EH
    |ear|(?:n|l|th|ch)=ER
    |ear|$=IH R
    |ea|=IY
    c|ei|=IY
    |ei|ther=IY
    |ei|gh=EY
    |ei|=EY
    ^[^aeiouy]*|ey|$=EY
    |ey|$=IY
    |ey|=EY
    [fvmpbkhc]|ew|=Y UW
    |ew|=UW
    |eu|=Y UW
    |err|=EH R
    |er|e$=IY R
    |er|V=EH R
    |er|=ER
    (?:[sxz]|ch|sh|[cg])|es|$=IH Z
    [aeiouy].*[td]|ed|$=IH D
    [aeiouy].*(?:[pkfsx]|sh|ch)|ed|$=T
    [aeiouy].*C|ed|$=D
    [aeiouy].*C|e|s$=
    [aeiouy].*C|e|$=
    [aeiouy].*C|e|ly$=
    [aeiouy].*C|e|ment=
    [aeiouy].*C|e|less=
    [aeiouy].*C|e|ful=
    ${FIRST}|e|C(?:e|es|ed|ing)$=IY
    |e|Ce$=IY
    ^C*|e|$=IY
    |e|$=
    |e|=EH
  `),
  f: R(`
    |ff|=F
    |f|=F
  `),
  g: R(`
    ^|gh|=G
    (?:ou|au)|gh|$=F
    |gh|=
    ^|gn|=N
    |gn|$=N
    |gg|=G
    |g|et=G
    ^|g|i=G
    |g|i(?:ve|rl|ft|n$|ng)=G
    |g|e[ae]=G
    |g|[eiy]=JH
    |g|=G
  `),
  h: R(`
    ^|h|=HH
    |h|V=HH
    |h|=
  `),
  i: R(`
    |igh|=AY
    ^[^aeiouy]*|ie|[ds]?$=AY
    |ie|$=AY
    |ie|nd=EH
    |ie|=IY
    |ir|e=AY ER
    |ir|=ER
    |i|nd$=AY
    |i|ld$=AY
    |i|gn=AY
    ^[^aeiouy]*|i|ve[sd]?$=AY
    |i|ve=IH
    ^[^aeiouy]*|i|ce=AY
    |i|ce=IH
    [a-z]{4,}|i|ne$=IH
    [a-z]{5,}|i|te$=IH
    ${FIRST}|i|C(?:e|es|ed|ing|ely)$=AY
    |i|Ce$=AY
    [nl]|i|on$=Y
    sh|i|on=
    ^[^aeiouy]*|i|[aoeu]=AY
    |i|[ao]=IY
    |i|$=IY
    |i|=IH
  `),
  j: R(`
    |j|=JH
  `),
  k: R(`
    ^|kn|=N
    |k|=K
  `),
  l: R(`
    |ll|=L
    [bcdfgkptz]|le|$=AH L
    |l|=L
  `),
  m: R(`
    |mm|=M
    |m|=M
  `),
  n: R(`
    |nn|=N
    |ng|(?:ing|er|ed|s|ly)?$=NG
    |ng|[lr]=NG G
    |ng|V=NG G
    |ng|=NG
    |n|k=NG
    |n|c[tl]=NG
    |n|=N
  `),
  o: R(`
    |oo|r=AO R
    |oo|k=UH
    |oo|d$=UH
    |oo|=UW
    |ough|t=AO
    |ou|ld=UH
    |ou|(?:ble|ple|ng|ch$|ntry|sin)=AH
    ^h?|our|$=AW ER
    |our|=AO R
    |ou|s$=AH
    |ou|=AW
    ^[hnc]|ow|$=AW
    (?:kn|gr|bl|sh|thr|fl|^)|ow|n=OW
    |ow|n=AW
    |ow|er=AW
    |ow|=OW
    |oa|=OW
    |oi|=OY
    |oy|=OY
    w|or|=ER
    |or|=AO R
    |o|ld=OW
    |o|lk=OW
    ^(?:p|h|gh)|o|st$=OW
    [ck]|o|ver=AH
    g|o|vern=AH
    |o|ll[aeiouy]=AA
    |o|ll=OW
    |o|rr=AA
    |o|(?:ng|ff|ft|ss)=AO
    |o|ther=AH
    |o|ney=AH
    c|o|m(?:e|es|ing)$=AH
    |o|h$=OW
    ${FIRST}|o|C(?:e|es|ed|ing|ely)$=OW
    |o|Ce$=OW
    |o|$=OW
    |o|=AA
  `),
  p: R(`
    |ph|=F
    |pp|=P
    ^|ps|=S
    |p|=P
  `),
  q: R(`
    |que|$=K
    |qu|=K W
    |q|=K
  `),
  r: R(`
    |rr|=R
    |r|=R
  `),
  s: R(`
    |sch|=S K
    |sh|=SH
    |ssion|=SH AH N
    [aeiouyr]|sion|=ZH AH N
    |sion|=SH AH N
    [aeiou]|s|ure=ZH
    |ss|u[ea]=SH
    |ss|=S
    ^|s|ure=SH
    [aeiouy]|s|[aeiouy]=Z
    [ptkf]e?|s|$=S
    th|s|$=S
    u|s|$=S
    [bdgvmnlr]e?|s|$=Z
    [aeiouy]|s|$=Z
    |s|=S
  `),
  t: R(`
    |tch|=CH
    [aeiou]|th|er=DH
    |th|=TH
    s|ti|on=CH
    |ti|o=SH
    |t|u[aeio]=CH
    |ti|a=SH
    |ture|$=CH ER
    s|t|(?:en|le)$=
    |tt|=T
    |t|=T
  `),
  u: R(`
    q|u|=W
    g|u|[aeiy]=
    (?:[rlj]|ch|s)|u|Ce$=UW
    ${FIRST}(?:[rlj]|ch|s)|u|C(?:e|es|ed|er|ing)$=UW
    |u|Ce$=Y UW
    ${FIRST}|u|C(?:e|es|ed|er|ing)$=Y UW
    |ue|$=UW
    |ui|=UW
    |ur|e$=Y UH R
    [tdsnlrj]|ur|V=UH R
    |ur|V=Y UH R
    |ur|=ER
    [pf]|u|(?:ll|sh|t$)=UH
    b|u|(?:ll|sh)=UH
    |u|$=UW
    |u|[aeio]=UW
    (?:^|[tdsnlrj])|u|C[aeiou]=UW
    |u|C[aeiou]=Y UW
    |u|=AH
  `),
  v: R(`
    |v|=V
  `),
  w: R(`
    ^|wr|=R
    |wh|=W
    |w|=W
  `),
  x: R(`
    ^|x|=Z
    e|x|[aeiouh]=G Z
    |x|=K S
  `),
  y: R(`
    ^|y|V=Y
    ^(?:[^aeiouy]*|gu)|y|$=AY
    ^[^aeiouy]*|ye|$=AY
    if|y|$=AY
    |y|ing$=AY
    |y|$=IY
    |y|Ce$=AY
    |y|=IH
  `),
  z: R(`
    |zz|=Z
    |z|=Z
  `),
};

/** AI is a rule-internal vowel: "ai" spelled — EY when stressed, reduced to AH when not ("contain" vs "certain") */
const VOWELS = new Set(["AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY", "IH", "IY", "OW", "OY", "UH", "UW", "AI"]);
const isV = (p: string) => VOWELS.has(p.replace(/[0-2]$/, ""));

/** letters → phones (no stress), by the ordered rules */
export function letterToSound(word: string): string[] {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  const out: string[] = [];
  let i = 0;
  while (i < w.length) {
    const rules = RULES[w[i]];
    let done = false;
    if (rules) for (const [l, letters, r, ph] of rules) {
      if (!w.startsWith(letters, i)) continue;
      if (l && !l.test(w.slice(0, i))) continue;
      if (r && !r.test(w.slice(i + letters.length))) continue;
      if (ph) out.push(...ph.split(" "));
      i += letters.length; done = true; break;
    }
    if (!done) i++;
  }
  // collapse doubled identical consonants produced across letter boundaries ("bookkeeper", "misspell")
  return out.filter((p, k) => !(k > 0 && p === out[k - 1] && !isV(p)));
}

/** unstressed suffixes (letters) and how many vowel phones they contribute */
const SUFFIXES: [string, number][] = [["ings", 1], ["ing", 1], ["ers", 1], ["er", 1], ["edly", 2], ["ed", 0], ["ly", 1], ["ness", 1], ["ful", 1], ["less", 1], ["ments", 1], ["ment", 1], ["es", 0], ["s", 0]];
const PREFIXES = /^(?:be|de|re|pre|un|in|im|con|com|dis|ex|ab|ad|ob|sub|en|em|mis|per)(?=[a-z]{3})|^a([bcdfglmnprstvz])\1?(?=[aeiouy]|r[aeiou])(?![a-z]{0,2}(?:le|ble|y|er|ea)$)/;
const PRE_STRESS = /(?:tion|sion|ical|ic|ial|ian|ious|ia|itive|ity|ify|logy|graphy|meter)s?$/;
const SUFFIX_VOWELS: Record<string, number> = { tion: 1, sion: 1, ic: 1, ical: 2, ial: 2, ian: 2, ious: 2, ia: 2, itive: 2, ity: 2, ify: 2, logy: 2, graphy: 2, meter: 2 };

/** stress + reduction for rule-generated phones */
export function assignStress(word: string, ph: string[]): string[] {
  const vi = ph.map((p, k) => (isV(p) ? k : -1)).filter((k) => k >= 0);
  const n = vi.length;
  if (n === 0) return ph;
  let target = 0;
  if (n === 1) target = 0;
  else {
    let stemN = n, w = word;
    for (const [suf, cnt] of SUFFIXES) if (w.endsWith(suf) && w.length - suf.length >= 3) { stemN = Math.max(1, n - cnt); w = w.slice(0, -suf.length); break; }
    const m = w.match(PRE_STRESS);
    if (m) {
      // every one of these suffixes puts the stress on the syllable just before it (a-BIL-i-ty, bi-OL-o-gy, e-lec-TRON-ic)
      const suf = m[0].replace(/s$/, "");
      const palatal = /[tcs]i(?:al|an|ous)$/.test(w); // -tial / -cian / -cious: the i merges into SH
      const sufV = SUFFIX_VOWELS[suf] - (palatal && /^(?:ial|ian|ious)$/.test(suf) ? 1 : 0);
      target = Math.max(0, stemN - sufV - 1);
    } else if (PREFIXES.test(w) && stemN >= 2) target = 1;
    else if (stemN === 2) target = 0;
    else if (stemN >= 3) {
      const pen = vi[stemN - 2], next = vi[stemN - 1];
      const longV = /^(?:EY|IY|AY|OW|UW|OY|AW)$/.test(ph[pen]);
      const cons = next - pen - 1;
      target = longV || cons >= 2 ? stemN - 2 : stemN - 3;
    }
    target = Math.max(0, Math.min(n - 1, target));
  }
  const out = ph.slice();
  const stressedAt = vi[target];
  vi.forEach((k, j) => {
    const base = out[k];
    if (base === "AI") { out[k] = j === target ? "EY1" : "AH0"; return; }
    if (j === target) { out[k] = base + "1"; return; }
    // unstressed prefixes keep a short i: re-, be-, de-, pre-, e-, ex-, en-, em- ("remember", "become", "example")
    if (j === 0 && /^(?:re|be|de|pre|e[xnm]?)/.test(word) && /^(?:EH|IY|AH|IH)$/.test(base)) { out[k] = "IH0"; return; }
    if (/^(?:AA|AE|AH|AO|EH|UH|ER)$/.test(base)) {
      // an unstressed vowel + R is r-coloured (ER) unless the R begins the stressed syllable ("difference", "camera";
      // but "around" keeps AH R)
      if (out[k + 1] === "R" && !(out[k + 2] && isV(out[k + 2]) && k + 2 === stressedAt)) { out[k] = "ER0"; out[k + 1] = "\u0000"; return; }
      out[k] = base === "ER" ? "ER0" : "AH0";
    } else if (base === "IH" && j > 0 && j < n - 1 && out[k + 1] !== "NG") out[k] = "AH0"; // medial unstressed i → schwa
    else out[k] = base + "0";
  });
  return out.filter((p) => p !== "\u0000");
}

/** pronunciation of one lowercase alphabetic word */
const COMPOUND = new Set(["some", "any", "every", "no", "one", "body", "thing", "where", "way", "ways", "self", "selves", "time", "times", "day", "how", "ever", "what", "who", "when", "out", "down", "back", "over", "under", "may", "him", "her", "them", "it", "my", "your", "our", "foot", "ball", "book", "work", "home", "side", "line", "light", "room", "place", "made", "less", "more", "most", "man", "men"]);
/** split a closed compound ("someone", "maybe", "himself") into two pronounceable parts */
function compound(w: string): string[] | null {
  for (let i = w.length - 2; i >= 2; i--) {
    const a = w.slice(0, i), b = w.slice(i);
    if ((COMPOUND.has(a) && (LEX.has(b) || COMPOUND.has(b))) || (COMPOUND.has(b) && LEX.has(a))) {
      const pa = pronounce(a), pb = pronounce(b).map((p) => p.replace(/1$/, "2"));
      return [...pa, ...pb];
    }
  }
  return null;
}

const SIB = /^(?:S|Z|SH|ZH|CH|JH)$/;
const lastP = (ph: string[]) => ph[ph.length - 1] ?? "";
/** the stem of an inflected word: doubled final consonant undone ("getting" → "get"), magic e restored ("making" →
 *  "make") when the stem's only vowel is followed by one consonant, "i" back to "y" ("countries" → "country") */
function stemOf(stem: string, yForm: boolean): string {
  if (yForm) return `${stem}y`;
  if (/([bdfgklmnprtvz])\1$/.test(stem) && !/(?:ll|ss|ff|zz)$/.test(stem)) return stem.slice(0, -1);
  if (LEX.has(stem)) return stem;
  if (LEX.has(`${stem}e`)) return `${stem}e`;
  if (/^[^aeiouy]*[aeiou][bcdfgkmnpstvz]$/.test(stem) || /^[^aeiouy]*[aeiou][cgsvz]$/.test(stem)) return `${stem}e`;
  // longer stems: the endings that are nearly always "-e" words (-ize, -ate, -ute, -ide, -uce, -ove, -ive, -ure …)
  if (/[^aeiou](?:iz|is|at|ut|us|ur|ir|ov|iv|id|ud|uc|ic|ag|ak|ap|ot|um)$/.test(stem) || /[aeiou][cv]$/.test(stem) || /[^aeiouyn][cgv]$/.test(stem)) return `${stem}e`;
  return stem;
}
/** inflection suffixes: decomposed so the stem keeps its own pronunciation and the suffix follows its last phone */
function morph(w: string): string[] | null {
  let m: RegExpMatchArray | null;
  if ((m = w.match(/^(.{2,}?)(ings?)$/)) && /[aeiouy]/.test(m[1])) { const st = pronounce(stemOf(m[1], false)); return [...st, "IH0", "NG", ...(m[2] === "ings" ? ["Z"] : [])]; }
  if ((m = w.match(/^(.{2,}?)(ied|ies)$/)) && m[1].length >= 3) { const st = pronounce(stemOf(m[1], true)); return [...st, m[2] === "ied" ? "D" : "Z"]; }
  if ((m = w.match(/^(.{3,}?[^e])ed$/)) && /[aeiouy]/.test(m[1])) {
    const st = pronounce(stemOf(m[1], false)), l = lastP(st);
    return [...st, ...(l === "T" || l === "D" ? ["IH0", "D"] : VOICELESS.test(l) ? ["T"] : ["D"])];
  }
  if ((m = w.match(/^(.{2,})e?s$/)) && !/(?:ss|us|is|ous)$/.test(w)) {
    const base = LEX.has(m[1]) ? m[1] : LEX.has(w.slice(0, -1)) ? w.slice(0, -1) : /(?:[^aeiouys]|[^aeiou]e)s$/.test(w) && w.length >= 5 ? w.slice(0, -1) : null;
    if (base) { const st = pronounce(base), l = lastP(st); return [...st, ...(SIB.test(l) ? ["IH0", "Z"] : VOICELESS.test(l) ? ["S"] : ["Z"])]; }
  }
  if ((m = w.match(/^(.{4,}?)(ly|ness|ment|ments|ful|less)$/)) && /[^aeiouy]$|e$/.test(m[1]) && /[aeiouy]/.test(m[1])) {
    const st = pronounce(m[1]);
    const suf = { ly: ["L", "IY0"], ness: ["N", "AH0", "S"], ment: ["M", "AH0", "N", "T"], ments: ["M", "AH0", "N", "T", "S"], ful: ["F", "AH0", "L"], less: ["L", "AH0", "S"] }[m[2]]!;
    return [...st, ...suf];
  }
  return null;
}

export function pronounce(word: string): string[] {
  const w = word.toLowerCase();
  const lx = LEX.get(w);
  if (lx) return lx;
  if (w.length >= 5) { const c = compound(w); if (c) return c; }
  if (w.length >= 4) { const mo = morph(w); if (mo) return mo; }
  // possessive / plural of a lexicon word
  if (w.endsWith("'s") && LEX.has(w.slice(0, -2))) return [...LEX.get(w.slice(0, -2))!, "Z"];
  if (w.endsWith("s") && LEX.has(w.slice(0, -1))) { const b = LEX.get(w.slice(0, -1))!; const last = b[b.length - 1]; return [...b, /^(?:P|T|K|F|TH)$/.test(last) ? "S" : /^(?:S|Z|SH|ZH|CH|JH)$/.test(last) ? "IH0 Z" : "Z"].flatMap((x) => x.split(" ")); }
  return voicing(w, assignStress(w, letterToSound(w)));
}

const VOICELESS = /^(?:P|T|K|F|TH|S|SH|CH)$/;
/** "-ed" and "-s" agree in voicing with the phone before them (decided on phones, not letters) */
function voicing(w: string, ph: string[]): string[] {
  const out = ph.slice(), n = out.length;
  if (n >= 2 && /[^e]ed$/.test(w) && out[n - 1] === "D" && VOICELESS.test(out[n - 2])) out[n - 1] = "T";
  if (n >= 2 && /[^su]s$/.test(w) && (out[n - 1] === "Z" || out[n - 1] === "S") && !isV(out[n - 2]) && !/^(?:S|Z|SH|ZH|CH|JH)$/.test(out[n - 2])) out[n - 1] = VOICELESS.test(out[n - 2]) ? "S" : "Z";
  return out;
}

export const spell = (w: string): string[] => [...w.toLowerCase()].flatMap((c) => (LETTER[c] ?? "").split(" ").filter(Boolean));

// ---------------------------------------------------------------------------------------------------------------
// normalisation

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES: [number, string][] = [[1e12, "trillion"], [1e9, "billion"], [1e6, "million"], [1e3, "thousand"]];

/** integer → English words (0 … 999 trillion) */
export function numberWords(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (n < 0) return `minus ${numberWords(-n)}`;
  n = Math.floor(n);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : "");
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ""}`;
  for (const [v, name] of SCALES) if (n >= v) return `${numberWords(Math.floor(n / v))} ${name}${n % v ? ` ${numberWords(n % v)}` : ""}`;
  return String(n);
}
const ORD: Record<string, string> = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };
export function ordinalWords(n: number): string {
  const w = numberWords(n).split(" "), last = w.pop()!;
  const o = ORD[last] ?? (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return [...w, o].join(" ");
}

const ABBREV: Record<string, string> = { "e.g.": "for example", "i.e.": "that is", "etc.": "et cetera", "vs.": "versus", "dr.": "doctor", "mr.": "mister", "mrs.": "missus", "ms.": "miz", "approx.": "approximately", "no.": "number" };
/** key and UI abbreviations read as words (screen-reader convention) */
const WORD_ABBREV: Record<string, string> = { ctrl: "control", cmd: "command", esc: "escape", del: "delete", alt: "alt", pgup: "page up", pgdn: "page down", fn: "function", btn: "button", img: "image", msg: "message", min: "minutes", sec: "seconds", ok: "okay" };
const SYMBOLS: Record<string, string> = { "&": "and", "@": "at", "%": "percent", "+": "plus", "=": "equals", "#": "number", "°": "degrees", "×": "times", "/": "slash", "~": "about", "<": "less than", ">": "greater than", "€": "euros", "£": "pounds" };

/** normalise text into words and phrase breaks */
export function normalize(text: string): { words: string[]; end: Phrase["end"] }[] {
  const phrases: { words: string[]; end: Phrase["end"] }[] = [];
  let cur: string[] = [];
  const push = (end: Phrase["end"]) => { if (cur.length) phrases.push({ words: cur, end }); cur = []; };
  // split camelCase / PascalCase ("SoundCloud" → "Sound Cloud") and letters↔digits ("tt31" → "tt 31")
  const t = text
    // URL schemes are noise when read aloud ("https://fusion.local" → "fusion dot local")
    .replace(/\b(?:https?|ftp):\/\/(?:www\.)?/gi, "")
    // clock times: "10:30" → "10 30", "9:05" → "9 oh 5", "7:00" → "7 o'clock"
    .replace(/\b(\d{1,2}):(\d{2})\b/g, (_m, h: string, mm: string) => mm === "00" ? `${h} o'clock` : mm[0] === "0" ? `${h} oh ${mm[1]}` : `${h} ${mm}`)
    // abbreviations whose dots are not sentence ends
    .replace(/(^|[^A-Za-z])(e\.g\.|i\.e\.|etc\.|vs\.|Dr\.|Mr\.|Mrs\.|Ms\.|approx\.|no\.(?=\s*\d))/gi, (_m, pre: string, ab: string) => `${pre}${ABBREV[ab.toLowerCase()]}`)
    .replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Za-z])(\d)/g, "$1 $2").replace(/(\d)(?!(?:st|nd|rd|th)\b)([A-Za-z])/g, "$1 $2")
    .replace(/\u2026/g, ".").replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d"]/g, " ").replace(/[\u2013\u2014]/g, ",");
  const re = /\$?\d[\d,]*(?:\.\d+)?(?:st|nd|rd|th)?%?|[A-Za-z]+(?:'[A-Za-z]+)?|[.!?;:,]|[&@%+=#°×/~<>€£]|\S/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const tok = m[0];
    if (/^[.!?;:]$/.test(tok)) {
      // a dot between two word characters ("notes.md") is spoken, not a sentence end
      const before = t[m.index - 1] ?? "", after = t[m.index + 1] ?? "";
      if (tok === "." && /\w/.test(before) && /\w/.test(after)) { cur.push("dot"); continue; }
      if (tok === ":" && /\w/.test(before) && /\w/.test(after)) continue;
      push(tok === "?" ? "?" : tok === "!" ? "!" : "."); continue;
    }
    if (tok === ",") { push(","); continue; }
    if (SYMBOLS[tok]) { cur.push(...SYMBOLS[tok].split(" ")); continue; }
    if (/^\$?\d/.test(tok)) {
      const money = tok.startsWith("$"), pct = tok.endsWith("%");
      const core = tok.replace(/^\$/, "").replace(/%$/, "");
      const ord = core.match(/^(\d+)(st|nd|rd|th)$/);
      if (ord) { cur.push(...ordinalWords(Number(ord[1])).split(" ")); continue; }
      const [ip, fp] = core.replace(/,/g, "").split(".");
      cur.push(...numberWords(Number(ip)).split(" "));
      if (fp) cur.push("point", ...[...fp].map((d) => ONES[Number(d)]));
      if (money) cur.push(Number(ip) === 1 && !fp ? "dollar" : "dollars");
      if (pct) cur.push("percent");
      continue;
    }
    if (/^[A-Za-z]/.test(tok)) {
      const low = tok.toLowerCase();
      if (WORD_ABBREV[low] && (low !== "min" && low !== "sec" || /\d\s*$/.test(t.slice(0, m.index)))) { cur.push(...WORD_ABBREV[low].split(" ")); continue; }
      // acronyms: all capitals up to 5 letters that are not words we know, and anything without a vowel letter
      if ((tok.length <= 5 && tok === tok.toUpperCase() && tok.length > 1 && !LEX.has(low)) || !/[aeiouy]/.test(low)) { cur.push(...[...low].map((c) => `#${c}`)); continue; }
      cur.push(low);
    }
  }
  push(".");
  return phrases;
}

/** text → phrases of phone tokens for the synthesiser */
export function textToPhrases(text: string): Phrase[] {
  return normalize(text).map(({ words, end }) => {
    const phones: PhoneTok[] = [];
    for (const w of words) {
      const ph = w.startsWith("#") ? spell(w.slice(1)) : pronounce(w);
      ph.forEach((p, k) => {
        const m = p.match(/^([A-Z]+)([0-2])?$/);
        if (!m) return;
        phones.push({ p: m[1], stress: m[2] !== undefined ? (Number(m[2]) as 0 | 1 | 2) : undefined, wordStart: k === 0, wordEnd: k === ph.length - 1 });
      });
    }
    return { phones, end };
  }).filter((p) => p.phones.length);
}
