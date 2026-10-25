"use client";

import type { CSSProperties, ReactNode } from "react";

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
  // An answer that opens with a list item has no conclusion line to lift out.
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

function emphasize(text: string): ReactNode[] {
  return text.split(EMPHASIS).map((part, index) =>
    index % 2 ? (
      <span key={index} className="ai-answer-em">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

const delay = (order: number) =>
  ({ "--ai-delay": `${Math.min(order, 9) * 90 + 60}ms` }) as CSSProperties;

export function AiAnswer({ text }: { text: string }) {
  const { headline, blocks } = parse(text);
  let order = 0;
  return (
    <div className="ai-answer" aria-live="polite">
      {headline && (
        <p className="ai-answer-headline" style={delay(order++)}>
          {emphasize(headline)}
        </p>
      )}
      {blocks.map((block, index) => {
        if (block.kind === "paragraph")
          return (
            <p key={index} className="ai-answer-paragraph" style={delay(++order)}>
              {emphasize(block.text)}
            </p>
          );
        const List = block.numbered ? "ol" : "ul";
        return (
          <List
            key={index}
            className={`ai-answer-list${block.numbered ? " is-numbered" : ""}`}
          >
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex} className="ai-answer-item" style={delay(++order)}>
                {emphasize(item)}
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
}

export function AiThinking({ label = "답변을 정리하고 있어요" }: { label?: string }) {
  return (
    <div className="ai-thinking" role="status" aria-live="polite">
      <div className="ai-thinking-head">
        <span className="ai-thinking-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="ai-thinking-label">{label}</span>
      </div>
      <div className="ai-thinking-lines" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}
