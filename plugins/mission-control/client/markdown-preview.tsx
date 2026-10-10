import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView, Text, View } from "react-native";
import { DocumentLinkText } from "./document-links";
import { documentLabel, isDocumentTarget, markdownTableCells as tableCells, wikiLink } from "./document-link-model";
import { formatDateTime } from "./date-time";

type Colors = PluginSurfaceProps["theme"]["colors"];
// A dependency-free reading view. External links/images stay text; vault links open in Docs.
function inline(value: string, colors: Colors, documentPath?: string): React.ReactNode[] {
  const parts: string[] = [];
  const tokens = /(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)|(?<!\\)\[\[[^\]]+\]\]|\*\*[^*]+\*\*|!?\[[^\]]*\]\([^)\s]+\)|\*[^*\s][^*]*\*/g;
  let end = 0;
  for (const token of value.matchAll(tokens)) { parts.push(value.slice(end, token.index), token[0]); end = token.index! + token[0].length; }
  parts.push(value.slice(end));
  return parts.map((part, index) => {
    const code = /^(`+)([\s\S]*?)\1$/.exec(part);
    if (code) return <Text key={index} style={{ fontFamily: "monospace", backgroundColor: colors.surface2 }}>{code[2]}</Text>;
    const wiki = wikiLink(part);
    if (wiki) return <DocumentLinkText key={index} link={wiki} sourcePath={documentPath} colors={colors} />;
    if (/^\*\*[^*]+\*\*$/.test(part)) return <Text key={index} style={{ fontWeight: "700" }}>{inline(part.slice(2, -2), colors, documentPath)}</Text>;
    const link = /^(!?)\[([^\]]*)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      if (!link[1] && documentPath !== undefined && isDocumentTarget(link[3])) return <DocumentLinkText key={index} link={{ target: link[3], label: documentLabel(link[3], link[2]), relative: true }} sourcePath={documentPath} colors={colors} />;
      return <Text key={index} style={{ color: colors.accent, textDecorationLine: link[1] ? "none" : "underline" }}>{link[1] ? `[image: ${link[2] || link[3]}]` : link[2]}</Text>;
    }
    if (/^\*[^*\s][^*]*\*$/.test(part)) return <Text key={index} style={{ fontStyle: "italic" }}>{inline(part.slice(1, -1), colors, documentPath)}</Text>;
    return part;
  });
}

export function MarkdownPreview({ content, colors, documentPath }: { content: string; colors: Colors; documentPath?: string }) {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  let codeFence: string | null = null;
  let tableEnd = -1;
  const lines = body.split(/\r?\n/);
  const text = { color: colors.foreground, fontSize: 14, lineHeight: 23 } as const;
  return <View style={{ gap: 3 }}>{lines.map((line, index) => {
    if (index <= tableEnd) return null;
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence && (!codeFence || (fence[1][0] === codeFence[0] && fence[1].length >= codeFence.length && line.slice(fence[0].length).trim() === ""))) { codeFence = codeFence ? null : fence[1]; return null; }
    if (codeFence) return <Text selectable key={index} style={[text, { fontFamily: "monospace", backgroundColor: colors.surface2, paddingHorizontal: 8 }]}>{line || " "}</Text>;
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) return <Text selectable key={index} accessibilityRole="header" style={{ color: colors.foreground, fontSize: Math.max(14, 24 - heading[1].length * 2), fontWeight: "600", lineHeight: 30, marginTop: 12 }}>{inline(heading[2], colors, documentPath)}</Text>;
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return <View key={index} style={{ height: 1, backgroundColor: colors.border, marginVertical: 8 }} />;
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) return <View key={index} style={{ borderLeftWidth: 3, borderLeftColor: colors.border, paddingLeft: 10 }}><Text selectable style={[text, { color: colors.foregroundMuted }]}>{quote[1] ? inline(quote[1], colors, documentPath) : " "}</Text></View>;
    const headers = tableCells(line), separators = tableCells(lines[index + 1] ?? "");
    if (headers.length > 1 && separators.length === headers.length && separators.every(cell => /^:?-{3,}:?$/.test(cell))) {
      const rows = [headers]; tableEnd = index + 1;
      while (tableEnd + 1 < lines.length && lines[tableEnd + 1].trim() && tableCells(lines[tableEnd + 1]).length > 1) rows.push(tableCells(lines[++tableEnd]));
      const widths = headers.map((_, column) => Math.min(320, Math.max(90, ...rows.map(row => (row[column]?.length ?? 0) * 7 + 24))));
      return <ScrollView key={index} horizontal accessibilityLabel="Markdown table. Scroll horizontally to see all columns." style={{ marginVertical: 10 }}>
        <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 6, overflow: "hidden" }}>
          {rows.map((row, rowIndex) => <View key={rowIndex} style={{ flexDirection: "row", backgroundColor: rowIndex === 0 ? colors.surface2 : colors.surface0, borderTopWidth: rowIndex ? 1 : 0, borderTopColor: colors.border }}>
            {headers.map((_, column) => <View key={column} style={{ width: widths[column], padding: 10, borderLeftWidth: column ? 1 : 0, borderLeftColor: colors.border }}>
              <Text selectable accessibilityRole={rowIndex === 0 ? "header" : undefined} style={[text, { fontSize: 13, lineHeight: 20, fontWeight: rowIndex === 0 ? "600" : "400", textAlign: separators[column].endsWith(":") ? separators[column].startsWith(":") ? "center" : "right" : "left" }]}>{inline(row[column] ?? "", colors, documentPath)}</Text>
            </View>)}
          </View>)}
        </View>
      </ScrollView>;
    }
    const indent = Math.min(8, (/^\s*/.exec(line)?.[0].replaceAll("\t", "    ").length ?? 0)) * 8;
    const task = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line), bullet = /^\s*[-*+]\s+(.*)$/.exec(line), numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    const marker = task ? (task[1].trim() ? "☑" : "☐") : bullet ? "•" : numbered ? `${numbered[1]}.` : "";
    const value = task ? task[2] : bullet ? bullet[1] : numbered ? numbered[2] : line;
    const handoff = /^(\[\[[^\]]+\]\])\s*·\s*(\d{4}-\d\d-\d\dT\S+)\s*·\s*([^·]+)\s*·\s*(\[\[[^\]]+\]\])\s*$/.exec(value);
    if (handoff && !indent && Number.isFinite(Date.parse(handoff[2]))) return <View key={index} style={{ gap: 6, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border }}>
      <Text style={[text, { fontSize: 15, fontWeight: "600" }]}>{inline(handoff[1], colors, documentPath)}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>Recorded {formatDateTime(handoff[2])} · {handoff[3].trim()}</Text>
      <Text style={{ fontSize: 12, lineHeight: 20 }}>{inline(handoff[4], colors, documentPath)}</Text>
    </View>;
    if (marker) return <View key={index} style={{ flexDirection: "row", alignItems: "flex-start", marginLeft: indent, marginTop: indent ? 2 : 7, gap: 6 }}>
      <Text style={[text, { color: colors.foregroundMuted, minWidth: 14 }]}>{marker}</Text>
      <Text selectable style={[text, { flex: 1, minWidth: 0 }]}>{inline(value, colors, documentPath)}</Text>
    </View>;
    return <Text selectable key={index} style={[text, { paddingLeft: indent }]}>{value ? inline(value, colors, documentPath) : " "}</Text>;
  })}</View>;
}
