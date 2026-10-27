/**
 * Layer 1: injection.
 *
 * An injection is text that tries to be obeyed by the system that reads it. Four things tell it apart from a
 * request: it overrides the rules the system runs under, it dictates a verdict or hides a limitation, it
 * addresses the machine reader instead of the human, or it tries to move data or actions out of band.
 *
 * Text from a document has no authority at all, so the same rules apply with a lower bar: a vendor PDF that
 * speaks to "AI assistants" or tells reviewers what to conclude is quarantined and shown to the reviewer.
 * A request that merely resembles an attack ("ignore the vendor summary and use the FDA text") names a source,
 * not the rules, and does not match. Quoting an attack in order to report it is discounted to a warning.
 *
 * Patterns run on normalised text (see text.ts); every hit is mapped back to a span of the original.
 */
import type { RiskFlag } from "../types.ts";
import { analyse, originalSpan, type Analysis } from "../text.ts";

export type InjectionKind = "pattern" | "role-drift" | "tool-ref" | "document-directive" | "exfiltration" | "concealment" | "obfuscation" | "model";

interface Rule {
  id: string;
  kind: InjectionKind;
  re: RegExp;
  /** Weight for a request typed by a user, and for text lifted out of a document. */
  w: { chat: number; doc: number };
  /** A match containing this is a reference to a document, not to the rules the system runs under. */
  exclude?: RegExp;
  /** Only in packs that ask for it. */
  pack?: "adversarial-tight";
}

const G = (src: string): RegExp => new RegExp(src, "g");

const OVERRIDE_VERB =
  "(?:ignore|disregard|forget|override|bypass|skip|discard|abandon|overrule|circumvent|neglect|dismiss|set aside|pay no attention to|do not follow|don't follow|stop following|never follow|no longer follow)";
const FILL = "(?:[a-z'-]+\\s+){0,4}?";
const TIER1 =
  "(?:instructions?|directions?|directives?|commands?|prompts?|system (?:prompt|message|instructions?)|guidelines?|guardrails?|safeguards?|safety (?:rules?|checks?|filters?|measures?|guidelines?)|rules?|polic(?:y|ies)|constraints?|programming|training|configuration)";
/** Words for the machinery that evaluates a claim. Ignoring them is the point of most attacks on a reviewer tool. */
const TIER2_EVALUATION = "(?:requirements?|criteria|review process|evaluation|assessment|vetting|due diligence|checklist|verification steps?)";
/** Words that also occur in ordinary device text ("ignore the warning if..."), so they score low on their own. */
const TIER2_DEVICE_TEXT = "(?:limitations?|restrictions?|exclusions?|caveats?|disclaimers?|warnings?|contraindications?|checks?)";
/** Words that make "instructions", "protocol" and the like a document the user is pointing at. */
const DOCUMENT_WORDS = /\b(?:vendor|manufacturer|brochure|labeling|labelling|label|ifu|package|insert|manual|device|product|clinical|study|operating|installation|cleaning|dosing|use|trial|registry|submission)\b/;

const AUDIENCE =
  "(?:reviewers?|assessors?|evaluators?|auditors?|assistants?|ai(?: tools?| systems?| models?)?|a\\.i\\.|llms?|language models?|models?|agents?|bots?|systems?|summari[sz]ers?|analysts?|automated [a-z]+)";
const MODAL =
  "(?:must|should|shall|will|are to|is to|need to|needs to|have to|has to|is required to|are required to|required to|please|kindly|always|never)";
const FAVOURABLE =
  "(?:supported(?:_for_scope)?|safe|cleared|approved|compliant|valid(?:ated)?|verified|acceptable|effective|sufficient|adequate|equivalent|covered|fully supported|supported for all|suitable for all)";
const STEER_VERB =
  "(?:mark|label|classify|rate|score|record|report|state|declare|certify|confirm|treat|regard|consider|set|assess|find|rule|conclude|determine|output|respond|answer|say|write|assign|tag|flag|rank|grade)";
const LIMIT_NOUN =
  "(?:limitations?|restrictions?|exclusions?(?: criteria| list)?|caveats?|warnings?|contraindications?|age (?:restriction|limit|bound)s?|discrepanc\\w+|conflicts?|disagreements?|negative (?:results?|findings?)|adverse events?|disclaimers?|footnotes?)";
const HIDE_VERB =
  "(?:omit|suppress|hide|conceal|leave out|do not (?:mention|report|list|include|flag|show|disclose|cite)|don't (?:mention|report|list|include|flag|show|disclose|cite)|never (?:mention|report|list|include|flag|cite)|without (?:mentioning|reporting|listing|including))";
const LABELS = "(?:supported_for_scope|supported_only_for_narrower_scope|contradicted_by_specified_evidence|insufficient_evidence|requires_domain_review)";
const AI_NOUN =
  "(?:ai|a\\.i\\.|llms?|large language models?|language models?|ai models?|assistants?|ai assistants?|chatbots?|agents?|ai agents?|automated [a-z]+|bots?|summari[sz]ers?|reviewing (?:ai|system|agent))";
/** An AI noun with an optional plural noun after it: "AI systems", "language models". */
const AI_READER = `${AI_NOUN}(?:\\s+(?:systems?|tools?|models?|assistants?|agents?|reviewers?|readers?|summari[sz]ers?|processors?))?`;
/** What an order to a reviewer or an AI asks it to conclude or to leave unsaid. */
const OUTCOME = `(?:${FAVOURABLE}|no\\s+(?:limitations?|restrictions?|exclusions?|caveats?|issues?|concerns?|discrepanc\\w+)(?:\\s+apply)?|all\\s+(?:patients|ages|populations|settings|uses|versions)|fully\\s+\\w+)`;
const READABLE = "(?:document|text|page|file|report|content|submission|summary|pdf|email|message|passage|section|record)";
const EXTERNAL_TARGET =
  "(?:(?:https?://|ftp://)\\S+|[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+|(?:[a-z0-9-]+\\.)+(?:com|net|org|io|ai|xyz|ru|cn|info|biz|me|co|dev|app|site|top|cc|tk)\\b|webhook\\S*|pastebin\\S*|an? external \\w+|my (?:personal|private|gmail|own) \\w+)";
/** A verb used as an instruction: it starts a sentence or follows a word that asks for an action. */
const IMPERATIVE = "(?:(?<=^|[.!?\\n:;]\\s*)|(?<=\\b(?:please|must|should|immediately|now|also|then|first|next|kindly|and)\\s+))";

const RULES: Rule[] = [
  // ---- override of the rules the system runs under
  { id: "override-instructions", kind: "pattern", re: G(`\\b${OVERRIDE_VERB}\\s+${FILL}${TIER1}\\b(?!\\s+for\\s+use)`), w: { chat: 0.95, doc: 0.95 }, exclude: DOCUMENT_WORDS },
  { id: "override-prior-context", kind: "pattern", re: G(`\\b${OVERRIDE_VERB}\\s+(?:everything|anything|all)\\s+(?:above|before|previously|you (?:were|have been) (?:told|given|instructed))`), w: { chat: 0.92, doc: 0.92 } },
  { id: "override-above-text", kind: "pattern", re: G(`\\b${OVERRIDE_VERB}\\s+(?:the\\s+|all\\s+of\\s+the\\s+)?(?:above|previous|preceding|prior|earlier)\\s+(?:text|messages?|context|conversation|input|content|sections?|passages?|paragraphs?)\\b`), w: { chat: 0.9, doc: 0.9 } },
  { id: "override-bare-above", kind: "pattern", re: G(`\\b(?:ignore|disregard|forget)\\s+(?:all\\s+|any\\s+|the\\s+)?(?:above|preceding|previous|prior)\\s*(?:[.,;:!]|$|\\band\\b|\\bthen\\b)`), w: { chat: 0.85, doc: 0.9 } },
  { id: "override-evaluation-rules", kind: "pattern", re: G(`\\b${OVERRIDE_VERB}\\s+${FILL}${TIER2_EVALUATION}\\b`), w: { chat: 0.6, doc: 0.9 }, exclude: DOCUMENT_WORDS },
  { id: "override-device-text", kind: "pattern", re: G(`\\b${OVERRIDE_VERB}\\s+${FILL}${TIER2_DEVICE_TEXT}\\b`), w: { chat: 0.5, doc: 0.4 }, exclude: DOCUMENT_WORDS },
  { id: "new-instructions", kind: "pattern", re: G("\\bnew\\s+(?:important\\s+)?(?:instructions?|task|directive|rules?)\\s*:"), w: { chat: 0.85, doc: 0.9 } },
  { id: "supersede-instructions", kind: "pattern", re: G("\\bthe\\s+following\\s+(?:instructions?|rules?)\\s+(?:supersede|replace|override|take\\s+precedence)"), w: { chat: 0.9, doc: 0.9 } },
  { id: "end-of-input-new-task", kind: "pattern", re: G("\\bend\\s+of\\s+(?:document|text|input|file|summary)\\b[^.?!\\n]{0,30}\\b(?:new|now)\\s+(?:task|instructions?|prompt)\\b"), w: { chat: 0.85, doc: 0.9 } },
  { id: "system-notice", kind: "pattern", re: G("\\bthis\\s+is\\s+(?:an?\\s+)?(?:system|admin|administrator|developer|priority|urgent)\\s+(?:message|override|instruction|notice|command)\\b"), w: { chat: 0.85, doc: 0.85 } },

  // ---- control tokens and fake roles
  { id: "role-markers", kind: "pattern", re: G("</?\\s*(?:system|assistant|user|tool|developer|instructions?)\\s*>|\\[\\s*/?\\s*inst\\s*\\]|<<\\s*/?\\s*sys\\s*>>|<\\|(?:im_start|im_end|system|endoftext|eot_id|start_header_id)\\|>"), w: { chat: 1, doc: 1 } },
  { id: "role-heading", kind: "pattern", re: G("(?:^|\\n)\\s*#{2,4}\\s*(?:system|instruction|new instructions?|admin)\\b|\\bbegin\\s+(?:system|hidden|admin)\\s+(?:prompt|instructions?|message)\\b|\"role\"\\s*:\\s*\"system\""), w: { chat: 0.9, doc: 0.9 } },
  { id: "role-line", kind: "pattern", re: G("(?:^|\\n)\\s*(?:system|assistant|developer)\\s*(?:prompt|message)?\\s*:\\s*[^\\n]{0,80}\\b(?:you|ignore|must|should|do not|always|never|mark|reveal|send)\\b"), w: { chat: 0.8, doc: 0.85 } },

  // ---- role drift
  { id: "drift-you-are-now", kind: "role-drift", re: G("\\byou\\s+are\\s+now\\b(?!\\s+(?:able|ready|going|being|in|at|on|viewing|reviewing|looking|logged|connected|signed|assigned))"), w: { chat: 0.55, doc: 0.7 } },
  { id: "drift-from-now-on", kind: "role-drift", re: G("\\bfrom\\s+now\\s+on\\b[^.?!\\n]{0,40}\\b(?:you|act|respond|answer|behave|ignore|always|never)\\b"), w: { chat: 0.7, doc: 0.8 } },
  { id: "drift-act-as-unrestricted", kind: "role-drift", re: G("\\b(?:act|behave|respond|answer|operate|work)\\s+(?:as|like)\\s+(?:if\\s+you\\s+(?:are|were)\\s+)?(?:an?\\s+|the\\s+)?(?:unrestricted|unfiltered|uncensored|jailbroken|root|admin(?:istrator)?|superuser|system|dan|evil|rogue|developer\\s+mode|god\\s+mode)"), w: { chat: 0.9, doc: 0.9 } },
  { id: "drift-you-are-now-persona", kind: "role-drift", re: G("\\byou\\s+are\\s+now\\s+(?:an?\\s+|the\\s+)?(?:dan|unrestricted|unfiltered|uncensored|jailbroken|evil|rogue|free|liberated|root|admin(?:istrator)?)\\b"), w: { chat: 0.9, doc: 0.9 } },
  { id: "drift-unrestricted", kind: "role-drift", re: G("\\b(?:unrestricted|unfiltered|uncensored)\\s+(?:ai|assistant|reviewer|mode|model|version)\\b"), w: { chat: 0.7, doc: 0.7 } },
  { id: "drift-pretend", kind: "role-drift", re: G("\\bpretend\\s+(?:to\\s+be|you\\s+(?:are|were)|that\\s+you\\s+(?:are|were))\\b"), w: { chat: 0.6, doc: 0.75 } },
  { id: "drift-pretend-system", kind: "role-drift", re: G("\\b(?:pretend|imagine|assume)\\b[^.?!\\n]{0,30}\\b(?:you\\s+are|to\\s+be|you're)\\s+(?:the\\s+|a\\s+|an\\s+)?(?:system|admin(?:istrator)?|root|operator|database\\s+admin|dba|superuser)\\b"), w: { chat: 0.85, doc: 0.85 } },
  { id: "drift-modes", kind: "role-drift", re: G("\\b(?:developer|god|debug|maintenance|admin|sudo|jailbreak|dan|unrestricted)\\s+mode\\b|\\bjailbreak(?:ed)?\\b|\\bdo\\s+anything\\s+now\\b"), w: { chat: 0.85, doc: 0.85 } },
  { id: "drift-no-rules", kind: "role-drift", re: G("\\b(?:no|without\\s+(?:any\\s+)?)\\s*(?:rules|restrictions|limits|filters|guardrails)\\b"), w: { chat: 0.35, doc: 0.35 } },

  // ---- steering the verdict, or hiding what limits it
  { id: "steer-label-names", kind: "document-directive", re: G(`\\b${LABELS}\\b`), w: { chat: 0, doc: 0.85 } },
  { id: "steer-verdict", kind: "document-directive", re: G(`\\b${STEER_VERB}\\b[^.?!\\n]{0,40}?\\b(?:as|to|that|with)\\s+(?:being\\s+)?["'\`]?${FAVOURABLE}\\b`), w: { chat: 0.5, doc: 0.88 } },
  { id: "steer-audience-modal", kind: "document-directive", re: G(`\\b${AUDIENCE}\\b[^.?!\\n]{0,40}\\b${MODAL}\\b[^.?!\\n]{0,24}\\b${STEER_VERB}\\b[^.?!\\n]{0,50}\\b(?:as|to|that)\\s+(?:being\\s+)?["'\`]?${OUTCOME}\\b`), w: { chat: 0.6, doc: 0.92 } },
  { id: "steer-audience-advised", kind: "document-directive", re: G(`\\b${AUDIENCE}(?:\\s+(?:and|or|,)\\s+${AUDIENCE})?\\b[^.?!\\n]{0,30}\\b(?:are|is)\\s+(?:advised|instructed|requested|asked|directed|required|expected|reminded)\\b`), w: { chat: 0.3, doc: 0.8 } },
  { id: "steer-audience-repeat", kind: "document-directive", re: G(`\\b${AUDIENCE}\\b[^.?!\\n]{0,40}\\b${MODAL}\\b[^.?!\\n]{0,20}\\b(?:repeat|echo|restate|reproduce|copy|relay|quote|paste)\\s+(?:this|that|the\\s+following|these)\\b`), w: { chat: 0.4, doc: 0.8 } },
  { id: "system-override", kind: "pattern", re: G("\\b(?:system|admin|developer|root|maintenance)\\s+override\\b"), w: { chat: 0.85, doc: 0.85 } },
  { id: "steer-hide-limits", kind: "document-directive", re: G(`\\b${HIDE_VERB}\\b[^.?!\\n]{0,40}\\b${LIMIT_NOUN}\\b`), w: { chat: 0.45, doc: 0.85 } },
  { id: "steer-no-further-evidence", kind: "document-directive", re: G("\\b(?:no\\s+(?:further|additional|more)\\s+(?:evidence|review|verification|validation|documentation|testing|data|scrutiny)\\s+(?:is|are|will\\s+be)?\\s*(?:required|needed|necessary))"), w: { chat: 0.2, doc: 0.4 } },
  { id: "steer-preapproved", kind: "document-directive", re: G("\\bpre-?(?:approved|cleared|verified|validated)\\b|\\balready\\s+(?:been\\s+)?(?:approved|cleared|verified|validated|reviewed|audited)\\s+by\\b"), w: { chat: 0.15, doc: 0.4 } },
  { id: "steer-supersedes-policy", kind: "document-directive", re: G("\\b(?:supersedes?|overrides?|takes\\s+precedence\\s+over|replaces?)\\s+(?:the\\s+|any\\s+|all\\s+)?(?:hospital'?s?|institution'?s?|your|reviewer'?s?|local|internal|organi[sz]ation'?s?)\\s*(?:requirements?|polic(?:y|ies)|criteria|review|assessment|process|rules|guidelines?)\\b"), w: { chat: 0.6, doc: 0.85 } },
  { id: "steer-waive-review", kind: "document-directive", re: G("\\b(?:reviewers?|you|assessors?|evaluators?)\\s+(?:do\\s+not|don't|need\\s+not|need\\s+no|no\\s+longer)\\s+(?:need\\s+to\\s+|have\\s+to\\s+)?(?:verify|check|review|validate|examine|assess|question|audit|confirm)\\b"), w: { chat: 0.3, doc: 0.8 } },
  { id: "steer-waiver", kind: "document-directive", re: G("\\b(?:waiv(?:e|ed|er)|exempt(?:ion)?)\\s+(?:of\\s+|from\\s+)?(?:the\\s+)?(?:review|requirements?|checks?|verification|validation)\\b"), w: { chat: 0.25, doc: 0.55 } },

  // ---- addressing the machine reader
  { id: "address-ai-note", kind: "document-directive", re: G(`\\b(?:(?:notes?|messages?|instructions?|notices?|attention|reminders?)\\s+(?:to|for)|(?:dear|hello|hey|hi))\\s+(?:the\\s+|any\\s+|all\\s+)?${AI_NOUN}\\b`), w: { chat: 0.3, doc: 0.78 } },
  { id: "address-ai-reading", kind: "document-directive", re: G(`\\b${AI_READER}\\s+(?:that\\s+|which\\s+|who\\s+)?(?:is\\s+|are\\s+)?(?:reading|processing|summari[sz]ing|analy[sz]ing|evaluating|reviewing|parsing|scanning|ingesting|crawling)\\s+(?:this|the|that)\\s+${READABLE}\\b`), w: { chat: 0.2, doc: 0.78 } },
  { id: "address-if-you-are-ai", kind: "document-directive", re: G(`\\bif\\s+you\\s+(?:are|'re)\\s+(?:an?\\s+|the\\s+)?${AI_NOUN}\\b`), w: { chat: 0.35, doc: 0.85 } },
  { id: "address-when-summarising", kind: "document-directive", re: G(`\\b(?:when|while|before|after)\\s+(?:you\\s+)?(?:summari[sz]ing|reviewing|analy[sz]ing|processing|reading|evaluating|answering|responding)\\b[^.?!\\n]{0,30}\\b(?:this|the)\\s+${READABLE}\\b[^.?!\\n]{0,40}\\b(?:must|should|always|never|please|remember|make\\s+sure|ensure)\\b`), w: { chat: 0.3, doc: 0.82 } },
  { id: "address-important", kind: "document-directive", re: G("\\bimportant\\s*(?:instruction|note|notice)s?\\s*(?:for|to)\\b"), w: { chat: 0.2, doc: 0.55 } },
  { id: "address-updated-instructions", kind: "document-directive", re: G("\\bupdated\\s+instructions?\\b"), w: { chat: 0.4, doc: 0.6 } },

  // ---- moving data or actions out of band
  { id: "exfil-reveal", kind: "exfiltration", re: G("\\b(?:reveal|print|show|display|dump|leak|expose|output|repeat|reproduce|recite|disclose|tell\\s+me|read\\s+out|echo)\\b[^.?!\\n]{0,40}\\b(?:system\\s+prompt|(?:your|the|initial|hidden|original|secret)\\s+(?:(?:hidden|secret|system|original|initial|internal)\\s+)*(?:instructions|prompt|rules|configuration)|api[\\s_-]?keys?|secret\\s+keys?|private\\s+keys?|(?:all|stored|saved|your|admin|login)\\s+(?:stored\\s+)?(?:credentials?|passwords?)|passwords?|access\\s+tokens?|bearer\\s+tokens?|environment\\s+variables?|\\.env\\b|contract\\s+secret|signing\\s+(?:key|secret))"), w: { chat: 0.9, doc: 0.92 } },
  { id: "exfil-send-out", kind: "exfiltration", re: G(`${IMPERATIVE}\\b(?:send|email|e-mail|mail|forward|post|upload|transmit|share|copy|submit|publish|exfiltrate|leak|attach|paste)\\b[^.?!\\n]{0,80}\\b(?:to|at|via|into|on)\\s+(?:the\\s+)?${EXTERNAL_TARGET}`), w: { chat: 0.5, doc: 0.9 } },
  { id: "exfil-send-out-data", kind: "exfiltration", re: G(`${IMPERATIVE}\\b(?:send|email|e-mail|forward|post|upload|transmit|share|copy|submit|publish|leak|paste)\\b[^.?!\\n]{0,40}\\b(?:conversation|chat|context|prompt|instructions|history|session|case\\s+(?:file|data)|dossier|documents?|findings|records|data)\\b[^.?!\\n]{0,60}\\b(?:to|at|via|into|on)\\s+(?:the\\s+)?${EXTERNAL_TARGET}`), w: { chat: 0.85, doc: 0.92 } },
  { id: "exfil-follow-link", kind: "exfiltration", re: G("\\b(?:fetch|visit|load|open|browse|download|follow|read)\\b[^.?!\\n]{0,20}\\b(?:this\\s+|the\\s+following\\s+)?(?:link|url|page|site|website)\\b[^.?!\\n]{0,40}\\b(?:and|then)\\s+(?:follow|obey|execute|run|do|apply|comply|carry\\s+out)\\b"), w: { chat: 0.85, doc: 0.9 } },
  { id: "exfil-markdown-image", kind: "exfiltration", re: G("!\\[[^\\]]*\\]\\(https?://[^)]*\\?[^)]*(?:data|q|text|content|prompt|payload)="), w: { chat: 0.8, doc: 0.9 } },

  // ---- out-of-band tools and destructive commands
  { id: "tool-dangerous", kind: "tool-ref", re: G("\\b(?:sudo|rm\\s+-rf|curl\\s+-|wget\\s+http|powershell(?:\\.exe)?\\s+-|bash\\s+-c|cmd\\.exe|eval\\(|exec\\(|os\\.system|subprocess\\.|drop\\s+table|truncate\\s+table|delete\\s+from|chmod\\s+7|nc\\s+-e)|\\|\\s*sh\\b"), w: { chat: 0.9, doc: 0.9 } },
  { id: "tool-grant-admin", kind: "tool-ref", re: G("\\bgrant\\s+(?:me|them|everyone|this\\s+user)?\\s*(?:admin|root|superuser|full)\\b(?:\\s+(?:access|rights|privileges|permissions))?"), w: { chat: 0.85, doc: 0.85 } },
  { id: "tool-disable-control", kind: "tool-ref", re: G("\\b(?:disable|turn\\s+off|deactivate|bypass|remove)\\s+(?:the\\s+)?(?:guard|gate|safety|safeguards?|approval|audit|logging|rate\\s*limit|verification|signature\\s+check|contract)s?\\b"), w: { chat: 0.85, doc: 0.85 } },

  // ---- dictating the answer, leaking the prompt, claiming authority, running commands
  { id: "dictate-output", kind: "document-directive", re: G(`\\b(?:reply|respond|answer|say|output|write)\\s+(?:only\\s+)?(?:with\\s+)?(?:the\\s+(?:word|phrase|text)\\s+)?["'\`]?(?:${FAVOURABLE}|no\\s+restrictions(?:\\s+apply)?|covered(?:\\s+for\\s+all\\s+uses)?|none)\\b`), w: { chat: 0.85, doc: 0.85 } },
  { id: "dictate-regardless", kind: "document-directive", re: G("\\b(?:answer|report|say|state|output|reply|respond|rate|conclude)\\b[^.?!\\n]{0,50}\\b(?:no\\s+matter\\s+what|regardless\\s+of|whatever\\s+(?:i|you|the))\\b"), w: { chat: 0.8, doc: 0.85 } },
  { id: "dictate-from-now-on", kind: "role-drift", re: G("\\bfrom\\s+now\\s+on\\b[^.?!\\n]{0,60}\\b(?:only|always|never|whatever|every)\\b|\\b(?:only|always)\\b[^.?!\\n]{0,40}\\bfrom\\s+now\\s+on\\b"), w: { chat: 0.7, doc: 0.8 } },
  { id: "prompt-leak-text", kind: "exfiltration", re: G("\\b(?:print|show|repeat|output|display|reveal|tell\\s+me|give\\s+me|write\\s+out|recite|copy)\\b[^.?!\\n]{0,30}\\b(?:text|words|messages?|content|everything|instructions?)\\b[^.?!\\n]{0,30}\\b(?:you\\s+were\\s+(?:given|told)|before\\s+my\\s+message|above\\s+this|you\\s+received|at\\s+the\\s+(?:start|beginning)|in\\s+your\\s+(?:context|prompt))"), w: { chat: 0.9, doc: 0.92 } },
  { id: "secret-in-reply", kind: "exfiltration", re: G("\\b(?:include|add|put|append|attach|embed)\\b[^.?!\\n]{0,30}\\b(?:secret|private|signing|api)\\s+(?:key|token|secret)s?\\b[^.?!\\n]{0,30}\\b(?:reply|answer|response|message|output)\\b"), w: { chat: 0.9, doc: 0.92 } },
  { id: "run-command", kind: "tool-ref", re: G("\\b(?:run|execute|launch)\\s+(?:the\\s+|a\\s+)?(?:shell\\s+|bash\\s+|system\\s+|terminal\\s+)?(?:command|script|code)\\b|\\b(?:cat|ls|rm|chmod|chown|nc|ssh|scp|wget|curl)\\s+(?:-\\w+\\s+)*/(?:etc|var|root|home|usr|bin|tmp)\\b"), w: { chat: 0.85, doc: 0.85 } },
  { id: "rules-do-not-apply", kind: "pattern", re: G("\\b(?:rules?|restrictions?|guidelines?|polic(?:y|ies)|safeguards?|limits?)\\b[^.?!\\n]{0,30}\\b(?:do(?:es)?\\s+not|don't|doesn't|no\\s+longer)\\s+apply\\b"), w: { chat: 0.85, doc: 0.85 } },
  { id: "claimed-authority", kind: "pattern", re: G("\\bi\\s+am\\s+(?:the\\s+|your\\s+)?(?:cmio|cio|cto|ceo|admin(?:istrator)?|developer|owner|operator|root|superuser|auditor|regulator|vendor)\\b[^.?!\\n]{0,40}\\b(?:act|so|therefore|you\\s+(?:must|should|can)|accordingly)\\b"), w: { chat: 0.5, doc: 0.5 } },
  { id: "skip-checks", kind: "pattern", re: G("\\b(?:skip|bypass|omit|forgo)\\s+(?:every|all|any|the)\\s+(?:checks?|verification|validations?|safeguards?)\\b"), w: { chat: 0.85, doc: 0.4 } },
  { id: "ai-omit-from-output", kind: "document-directive", re: G(`\\b(?:${AI_READER}|reviewers?|assessors?|summari[sz]ers?|bots?)\\b[^.?!\\n]{0,60}\\b(?:omit|remove|exclude|leave\\s+out|replace|delete|hide|suppress|drop)\\b[^.?!\\n]{0,60}\\b(?:output|summary|answer|response|report|reply|mention)\\b`), w: { chat: 0.4, doc: 0.85 } },
  { id: "vocative-ai", kind: "document-directive", re: G("(?:^|[.!?\\n>\\]]\\s*)(?:attention|note|notice|important|reminder|message|dear|hello|hey)?[\\s,:-]*(?:to\\s+(?:the\\s+|any\\s+|all\\s+)?|for\\s+(?:the\\s+|any\\s+|all\\s+)?)?(?:evaluating|reviewing|reading|processing|summari[sz]ing|assessing|screening|automated)\\s+(?:ai|models?|assistants?|bots?|tools?|agents?|llms?|systems?)\\b"), w: { chat: 0.3, doc: 0.8 } },
  { id: "vocative-language-model", kind: "document-directive", re: G("\\b(?:attention|note|notice|important|reminder|message|dear|hello|hey|to|for)\\b[\\s,:-]+(?:the\\s+|any\\s+|all\\s+)?(?:language\\s+models?|llms?|ai\\s+(?:assistants?|agents?|tools?|systems?|models?)|chatbots?|bots?)\\b"), w: { chat: 0.3, doc: 0.8 } },
  { id: "ai-tool-instructed", kind: "document-directive", re: G("\\b(?:ai|llm|model|assistant|bot)\\s+(?:tool\\s+)?(?:is|are)\\s+used\\s+to\\s+(?:review|assess|evaluate|summari[sz]e|screen|read)\\b[^.?!\\n]{0,60}\\b(?:must|should|shall|will)\\b"), w: { chat: 0.3, doc: 0.85 } },
  { id: "ignore-elsewhere", kind: "document-directive", re: G("\\b(?:disregard|ignore|discard|overlook)\\s+(?:the\\s+|any\\s+|all\\s+)?(?:[a-z-]+\\s+){0,2}(?:limits?|limitations?|restrictions?|exclusions?|caveats?)\\b[^.?!\\n]{0,40}\\b(?:elsewhere|above|below|earlier|previously|in\\s+this\\s+(?:document|report|summary|submission))\\b"), w: { chat: 0.5, doc: 0.85 } },
  { id: "verified-by-committee", kind: "document-directive", re: G("\\b(?:treat|regard|consider|take)\\b[^.?!\\n]{0,40}\\b(?:as\\s+)?(?:verified|approved|cleared|validated|confirmed)\\s+by\\s+(?:the\\s+)?(?:hospital|institution|your|reviewer|local|internal|committee|regulator|fda)"), w: { chat: 0.4, doc: 0.8 } },

  // ---- concealment
  { id: "conceal", kind: "concealment", re: G("\\b(?:do\\s+not|don't|never)\\s+(?:tell|inform|notify|alert|show|let)\\s+(?:this\\s+|these\\s+|the\\s+|your\\s+|any\\s+)?(?:to\\s+)?(?:user|reviewer|human|operator|owner|anyone)\\b|\\bwithout\\s+(?:telling|informing|notifying)\\s+(?:the\\s+)?(?:user|reviewer|human|operator)|\\bkeep\\s+this\\s+(?:secret|hidden|between\\s+us)\\b"), w: { chat: 0.6, doc: 0.7 } },

  // ---- stricter pack
  { id: "tight-translate-wrapper", kind: "pattern", re: G("\\b(?:translate|decode|rot13|reverse|spell|paraphrase|summari[sz]e)\\b[^.?!\\n]{0,40}(?:ignore|disregard|reveal|grant|override)"), w: { chat: 0.4, doc: 0.4 }, pack: "adversarial-tight" },
  { id: "tight-hypothetical", kind: "pattern", re: G("\\b(?:hypothetically|in\\s+a\\s+fictional|for\\s+a\\s+story|imagine\\s+that)\\b[^.?!\\n]{0,60}\\b(?:no\\s+rules|without\\s+restrictions|ignore|bypass)\\b"), w: { chat: 0.45, doc: 0.45 }, pack: "adversarial-tight" },
];

export interface InjectionPackConfig {
  /** Score at or above which the request is blocked (user text) or quarantined (document text). */
  blockAt: { chat: number; doc: number };
  warnAt: { chat: number; doc: number };
  tight: boolean;
  /** Quoted attack text is scored at this fraction of its weight. */
  mentionFactor: number;
}

export interface InjectionHit {
  rule: string;
  kind: InjectionKind;
  score: number;
  span: [number, number];
  evidence: string;
  view: string;
  inHiddenText: boolean;
  mentioned: boolean;
}

export interface InjectionResult {
  score: number;
  verdict: "pass" | "warn" | "block";
  hits: InjectionHit[];
  flags: RiskFlag[];
  analysisFlags: string[];
}

export interface InjectionContext {
  surface: "chat" | "doc";
  /** Names the current intent may legitimately refer to (capabilities and intent ids). */
  knownTools: ReadonlySet<string>;
}

const TLD_OR_EXT = /\.(?:com|gov|org|net|edu|io|ai|int|eu|uk|de|fr|pdf|csv|json|txt|xml|docx?|xlsx?|md|html?|png|jpe?g|zip|tsv|yaml|yml)$/;
const TOOL_CALL = /\b(?:use|call|invoke|run|execute|launch|trigger|activate)\s+(?:the\s+)?(?:tool\s+|function\s+|command\s+)?([a-z][a-z0-9]*(?:[_.][a-z0-9]+)+)\b/g;

function clip(s: string, n = 80): string {
  return s.length <= n ? s : `${s.slice(0, n - 3)}...`;
}

/**
 * Whether the match is quoted, or introduced as something a document says, rather than being asked of the
 * system. This is a heuristic: it lowers a hit to a warning; it never clears one.
 */
function isMention(raw: string, span: [number, number]): boolean {
  const [s, e] = span;
  const before = raw.slice(Math.max(0, s - 90), s);
  const after = raw.slice(e, e + 160);
  const cue = /(?:says?|said|states?|stated|reads?|wrote|written|text|phrase|sentence|wording|line|contains?|containing|quote[sd]?|appears?|excerpt|passage|snippet|message|tells?)\b[^"“`]{0,30}$/i;
  const cueBefore = cue.test(before.replace(/["“`']\s*$/, ""));
  const openQuote = /["“`]\s*[^"“”`]{0,12}$/.test(before) || /(?:^|\s)'\s*[^']{0,12}$/.test(before);
  const closeQuote = /^[^"“”`]{0,160}["”`]/.test(after) || /^[^']{0,160}'(?:\s|$|[.,;:!?)—-])/.test(after);
  const quoted = openQuote && closeQuote;
  const frame =
    /\b(?:flag|report|quarantine|detect|scan|check|identify|highlight|list|find|tell|show)\b[^.?!]{0,50}\b(?:injection|instruction-like|suspicious|hidden|embedded|manipulat\w*|prompt)/i.test(raw) ||
    /\b(?:does|do|did|is|are)\b[^?]{0,40}\b(?:pdf|document|page|brochure|summary|text|file|submission|vendor)\b[^?]{0,40}\b(?:contain|include|have|say|state|tell)\b/i.test(raw);
  return (quoted && cueBefore) || (frame && (quoted || cueBefore));
}

export function detectInjection(raw: string, cfg: InjectionPackConfig, ctx: InjectionContext, analysis: Analysis = analyse(raw)): InjectionResult {
  const hits: InjectionHit[] = [];
  const seen = new Set<string>();
  const primary = analysis.views.find((v) => v.label === "primary");
  for (const view of analysis.views) {
    for (const rule of RULES) {
      if (rule.pack === "adversarial-tight" && !cfg.tight) continue;
      const base = rule.w[ctx.surface];
      if (base <= 0) continue;
      for (const m of view.m.text.matchAll(rule.re)) {
        if (m[0].length === 0) continue;
        if (rule.exclude?.test(m[0])) continue;
        const s = m.index as number;
        const span = originalSpan(view, s, s + m[0].length);
        const key = `${rule.id}|${span[0]}|${span[1]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const obf = view.label !== "primary";
        // A match that exists only after normalisation was written to dodge the patterns.
        const alsoInPrimary = obf && primary ? new RegExp(rule.re.source, "g").test(primary.m.text) : false;
        const inHidden = analysis.hiddenSpans.some(([a, b]) => span[0] >= a && span[1] <= b);
        let w = base;
        const mentioned = ctx.surface === "chat" && !obf && isMention(analysis.raw, span);
        if (mentioned) w *= cfg.mentionFactor;
        if (obf && !alsoInPrimary) w = Math.min(1, w + 0.15);
        if (inHidden) w = Math.min(1, w + 0.2);
        hits.push({ rule: rule.id, kind: obf && !alsoInPrimary ? "obfuscation" : rule.kind, score: w, span, evidence: clip(analysis.raw.slice(span[0], span[1])), view: view.label, inHiddenText: inHidden, mentioned });
      }
    }
    // tool references that are not reachable from the intents Sakaime has
    if (view.label === "primary") {
      for (const m of view.m.text.matchAll(TOOL_CALL)) {
        const ident = m[1] as string;
        if (ctx.knownTools.has(ident) || TLD_OR_EXT.test(ident)) continue;
        const s = m.index as number;
        const span = originalSpan(view, s, s + m[0].length);
        const key = `tool-unknown|${span[0]}|${span[1]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ rule: "tool-unknown", kind: "tool-ref", score: 0.85, span, evidence: clip(analysis.raw.slice(span[0], span[1])), view: "primary", inHiddenText: false, mentioned: false });
      }
    }
  }

  // Text a document hides in a comment or invisible markup has no reason to address a reader at all.
  for (const [a, b] of analysis.hiddenSpans) {
    const inner = analysis.raw.slice(a, b);
    if (/\b(?:system|assistant|ai|llm|model|reviewer|instructions?|ignore|disregard|output|mark|report|state|say|conclude|do not)\b/i.test(inner)) {
      hits.push({ rule: "hidden-directive", kind: "document-directive", score: ctx.surface === "doc" ? 0.85 : 0.5, span: [a, b], evidence: clip(inner), view: "primary", inHiddenText: true, mentioned: false });
    }
  }

  // The strongest hit of each rule, combined as independent evidence.
  const best = new Map<string, InjectionHit>();
  for (const h of hits) if ((best.get(h.rule)?.score ?? -1) < h.score) best.set(h.rule, h);
  const chosen = [...best.values()].sort((a, b) => b.score - a.score);
  const score = chosen.length ? 1 - chosen.reduce((p, h) => p * (1 - Math.min(0.999, h.score)), 1) : 0;
  const block = cfg.blockAt[ctx.surface];
  const warn = cfg.warnAt[ctx.surface];
  const verdict = score >= block ? "block" : score >= warn ? "warn" : "pass";
  const flags: RiskFlag[] =
    verdict === "pass"
      ? []
      : chosen.slice(0, 6).map((h) => ({ layer: "injection", verdict: score >= block ? "block" : "warn", kind: h.kind, rule: h.rule, score: Number(h.score.toFixed(3)), span: h.span, evidence: h.evidence }));
  const shown = new Set(["hidden-characters", "bidi-control", "homoglyphs", "encoded-payload", "hidden-markup", "leetspeak", "spaced-letters"]);
  for (const f of analysis.flags) {
    if (shown.has(f) && (verdict !== "pass" || cfg.tight)) flags.push({ layer: "injection", verdict: "warn", kind: "obfuscation", rule: f });
  }
  return { score, verdict, hits: chosen, flags, analysisFlags: analysis.flags };
}

export const INJECTION_RULE_IDS: readonly string[] = RULES.map((r) => r.id);
