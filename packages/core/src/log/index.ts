export * as Log from "./index";
export { Search } from "./search";

export type LogEvent =
  // end
  | ["e", number, string, string]
  // start
  | ["s", number, string, string, boolean]
  // report
  | ["r", number, string, string, number]
  // message
  | ["m", number, string, string, string, string, string]
  // trace
  | [
      "t",
      number /* timestamp */,
      string /* logGroup */,
      string /* requestID */,
      string /* type */,
      string /* message */,
      string[] /* trace */
    ];

export function process(input: {
  id: string;
  line: string;
  timestamp: number;
  group: string;
  stream: string;
  cold: Set<string>;
  invocations: Map<string, number>;
}): LogEvent | undefined {
  function generateID(id: string) {
    const trimmed = id.trim();
    const count = input.invocations.get(trimmed);
    if (!count) return trimmed + "    ";
    return id + "[" + count + "]";
  }
  const tabs = input.line.split("\t");
  if (tabs[0]?.startsWith("INIT_START")) {
    input.cold.add(input.stream);
    return;
  }
  if (tabs[0]?.startsWith("START")) {
    const splits = tabs[0].split(" ");
    const cold = input.cold.has(input.stream);
    input.cold.delete(input.stream);
    return ["s", input.timestamp, input.group, generateID(splits[2]!), cold];
  }

  if (tabs[0]?.startsWith("END")) {
    const splits = tabs[0].split(" ");
    return ["e", input.timestamp, input.group, generateID(splits[2]!)];
  }

  if (tabs[0]?.startsWith("REPORT")) {
    const generated = generateID(tabs[0].split(" ")[2]!);
    const requestID = tabs[0].split(" ")[2]!.trim();
    input.invocations.set(
      requestID,
      (input.invocations.get(requestID) || 0) + 1
    );
    return [
      "r",
      input.timestamp,
      input.group,
      generated,
      parseInt(tabs[2]?.split(" ")[2] || "0"),
    ];
  }

  if (tabs[0]?.length === 24) {
    if (tabs[3]?.includes("Invoke Error")) {
      const parsed = JSON.parse(tabs[4]!);
      return [
        "t",
        input.timestamp,
        input.group,
        generateID(tabs[1]!),
        parsed.errorType,
        parsed.errorMessage,
        parsed.stack,
      ];
    }
    return [
      "m",
      input.timestamp,
      input.group,
      generateID(tabs[1]!),
      tabs[2]!.trim(),
      tabs.slice(3).join("\t").trim(),
      input.id,
    ];
  }
  console.log("unhandled log line", tabs);
}
