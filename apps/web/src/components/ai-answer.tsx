"use client";

import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

// AI answers arrive as "결론 한 문장" + "- 항목" lines. Older answers can be a
// plain paragraph or carry stray markdown, so parsing stays forgiving.
type Line = { text: string; marker: "" | "bullet" | "number" };
type Block =
  | { kind: "paragraph"; text: string }
  | { kind: "list"; numbered: boolean; items: string[] };

const BULLET = /^(?:[-*+]\s+|[•·▪●◦‣–]\s*)/;
const NUMBER = /^(?:\d{1,2}[.)]\s+|[①-⑳]\s*)/;
const RULE = /^[-=_*|:\s]{3,}$/;
const LABEL = /^(?:결론|요약|한 줄 요약|답변)\s*[:：]\s*/;
const LABEL_ONLY = /^(?:결론|요약|한 줄 요약|답변)\s*[:：]?$/;

const WEEKDAY = "\\s?\\([월화수목금토일]\\)";
const DATE = [
  `\\d{4}[-.]\\d{1,2}[-.]\\d{1,2}(?:${WEEKDAY})?`,
  `\\d{1,2}월\\s?\\d{1,2}일(?:${WEEKDAY})?`,
  `\\d{1,2}일${WEEKDAY}`,
].join("|");
const UNIT =
  "개월|개|만\\s?원|천\\s?원|원|%p|%|°C|℃|°|도|mm|kg|g|ml|L|건|주일|주|일|배|명|시간|시|분|병|봉지|봉|박스|상자|팩|캔|판|회|번|위";
const AMOUNT = `[+\\-−]?\\d[\\d,]*(?:\\.\\d+)?(?:\\s?[~∼–-]\\s?\\d[\\d,]*(?:\\.\\d+)?)?\\s?(?:${UNIT})(?![A-Za-z])`;
const EMPHASIS = new RegExp(`(${DATE}|${AMOUNT})`, "g");

function readLine(raw: string): Line | null {
  let text = raw
    .trim()
    .replace(/\*\*|__|`+/g, "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/^>\s*/, "");
  if (!text || RULE.test(text) || LABEL_ONLY.test(text)) return null;
  if (text.startsWith("|"))
    text = text
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join(" · ");
  let marker: Line["marker"] = "";
  if (BULLET.test(text)) {
    marker = "bullet";
    text = text.replace(BULLET, "");
  } else if (NUMBER.test(text)) {
    marker = "number";
    text = text.replace(NUMBER, "");
  }
  text = text.replace(/\s+/g, " ").trim();
  return text ? { text, marker } : null;
}

function sentences(text: string) {
  return text
    .replace(/([.!?。])\s+/g, "$1\n")
    .split("\n")
    .map((part) => part.trim())
    .filter(Boolean);
}

// Two short sentences per paragraph keeps old wall-of-text answers readable.
function paragraphs(text: string) {
  const result: string[] = [];
  let current: string[] = [];
  for (const sentence of sentences(text)) {
    const length = current.join(" ").length + sentence.length;
    if (current.length && (current.length >= 2 || length > 90)) {
      result.push(current.join(" "));
      current = [];
    }
    current.push(sentence);
  }
  if (current.length) result.push(current.join(" "));
  return result;
}

function parse(text: string) {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(readLine)
    .filter((line): line is Line => line !== null);
  if (!lines.length) return { headline: "", blocks: [] as Block[] };
  const first = lines[0].marker ? null : lines[0];
  const rest = first ? lines.slice(1) : lines;
  const opening = first ? sentences(first.text.replace(LABEL, "")) : [];
  const headline = first ? (opening[0] ?? first.text) : "";
  const leftover = opening.slice(1).join(" ");
  const blocks: Block[] = [];
  const addParagraphs = (value: string) => {
    for (const part of paragraphs(value))
      blocks.push({ kind: "paragraph", text: part });
  };
  if (rest.some((line) => line.marker)) {
    if (leftover) addParagraphs(leftover);
    for (const line of rest) {
      const last = blocks[blocks.length - 1];
      if (!line.marker) addParagraphs(line.text);
      else if (last?.kind === "list" && last.numbered === (line.marker === "number"))
        last.items.push(line.text);
      else
        blocks.push({
          kind: "list",
          numbered: line.marker === "number",
          items: [line.text],
        });
    }
  } else {
    for (const part of [leftover, ...rest.map((line) => line.text)])
      if (part) addParagraphs(part);
  }
  return { headline, blocks };
}

// A highlighted amount such as "10월 27일(화)" stays one word so its marker is
// never split. Spaces stay plain text so the answer copies as one sentence.
type Piece = { text: string; em: boolean };
type Token = string | Piece[];
type Words = { tokens: Token[]; start: number };

function words(text: string): Token[] {
  const tokens: Token[] = [];
  let word: Piece[] = [];
  const close = () => {
    if (word.length) tokens.push(word);
    word = [];
  };
  text.split(EMPHASIS).forEach((part, index) => {
    if (!part) return;
    if (index % 2) {
      word.push({ text: part, em: true });
      return;
    }
    for (const bit of part.split(/(\s+)/)) {
      if (!bit) continue;
      if (/^\s+$/.test(bit)) {
        close();
        tokens.push(bit);
      } else word.push({ text: bit, em: false });
    }
  });
  close();
  return tokens;
}

const order = (index: number) =>
  ({ "--w": String(index) }) as CSSProperties;

function wordSpans({ tokens, start }: Words): ReactNode[] {
  let index = start;
  return tokens.map((token, key) =>
    typeof token === "string" ? (
      token
    ) : (
      <span key={key} className="ai-word" style={order(index++)}>
        {token.map((piece, part) =>
          piece.em ? (
            <span key={part} className="ai-answer-em">
              {piece.text}
            </span>
          ) : (
            piece.text
          ),
        )}
      </span>
    ),
  );
}

// Words blur in one after another; long answers speed up so the whole reveal
// still ends in about 2.7 seconds.
const REVEAL_WINDOW = 1650;
const WORD_STEP = 30;

export function AiAnswer({ text }: { text: string }) {
  const { headline, blocks } = parse(text);
  let count = 0;
  const line = (value: string): Words => {
    const tokens = words(value);
    const start = count;
    count += tokens.filter((token) => typeof token !== "string").length;
    return { tokens, start };
  };
  const head = headline ? line(headline) : null;
  const body = blocks.map((block) =>
    block.kind === "paragraph"
      ? { kind: block.kind, line: line(block.text) }
      : { kind: block.kind, numbered: block.numbered, items: block.items.map(line) },
  );
  const step = Math.min(WORD_STEP, REVEAL_WINDOW / Math.max(count, 1));
  return (
    <div
      className="ai-answer"
      aria-live="polite"
      style={{ "--ai-step": `${step.toFixed(1)}ms` } as CSSProperties}
    >
      {head && <p className="ai-answer-headline">{wordSpans(head)}</p>}
      {body.map((block, index) => {
        if (block.kind === "paragraph")
          return (
            <p key={index} className="ai-answer-paragraph">
              {wordSpans(block.line)}
            </p>
          );
        const List = block.numbered ? "ol" : "ul";
        return (
          <List
            key={index}
            className={`ai-answer-list${block.numbered ? " is-numbered" : ""}`}
          >
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex} className="ai-answer-item" style={order(item.start)}>
                {wordSpans(item)}
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
}

const THINKING_STEPS = ["날씨와 예측을 확인하고 있어요", "답변을 정리하고 있어요"];
const STEP_MS = 2400;

/** `label` is shown first and is what screen readers hear; `steps` follow it
 * on a timer and stop at the last one. */
export function AiThinking({
  label = "자료를 읽고 있어요",
  steps = THINKING_STEPS,
}: {
  label?: string;
  steps?: readonly string[];
}) {
  const messages = [label, ...steps.filter((message) => message !== label)];
  const [step, setStep] = useState(0);
  const last = messages.length - 1;
  const current = Math.min(step, last);
  useEffect(() => {
    if (current >= last) return;
    const timer = window.setTimeout(() => setStep(current + 1), STEP_MS);
    return () => window.clearTimeout(timer);
  }, [current, last]);
  return (
    <div className="ai-thinking" role="status" aria-live="polite">
      <span className="ai-thinking-ring" aria-hidden="true" />
      <div className="ai-thinking-head">
        <span className="ai-thinking-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="ai-thinking-label">
          {messages.map((message, index) => (
            <span
              key={index}
              className="ai-thinking-step"
              data-state={
                index < current ? "past" : index === current ? "active" : "next"
              }
              aria-hidden={index > 0 || undefined}
            >
              {message}
            </span>
          ))}
        </span>
      </div>
      <div className="ai-thinking-lines" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

export function AiOutput({ children }: { children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = outer.current;
    const content = inner.current;
    if (!box || !content || typeof ResizeObserver === "undefined") return;
    // Clip only while the height moves, so the thinking glow can spill out.
    const settle = (event: TransitionEvent) => {
      if (event.target === box) box.classList.remove("is-moving");
    };
    const fit = () => {
      const height = `${content.offsetHeight}px`;
      if (box.style.height === height) return;
      box.classList.add("is-moving");
      box.style.height = height;
    };
    box.style.height = "0px";
    void box.offsetHeight; // commit the closed size so the first fit animates
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(content);
    box.addEventListener("transitionend", settle);
    box.addEventListener("transitioncancel", settle);
    return () => {
      observer.disconnect();
      box.removeEventListener("transitionend", settle);
      box.removeEventListener("transitioncancel", settle);
      box.style.height = "";
      box.classList.remove("is-moving");
    };
  }, []);
  return (
    <div ref={outer} className="ai-output">
      <div ref={inner} className="ai-output-inner">
        {children}
      </div>
    </div>
  );
}
