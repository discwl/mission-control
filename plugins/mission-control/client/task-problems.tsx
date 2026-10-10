import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { taskProblemLine, type TaskFileProblem } from "../shared/tasks";

type Colors = PluginSurfaceProps["theme"]["colors"];

/** A warning for each invalid task file the vault read skipped, so one bad file never hides the rest. */
export function TaskProblems({ problems, colors }: { problems: readonly TaskFileProblem[] | undefined; colors: Colors }) {
  if (!problems?.length) return null;
  return <View accessibilityRole="alert" style={{ gap: 3 }}>
    {problems.map(problem => <Text key={problem.file} selectable style={{ color: colors.statusWarning, fontSize: 12 }}>{taskProblemLine(problem)}</Text>)}
    <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{problems.length === 1 ? "This task is" : "These tasks are"} left out until the file is fixed in dev-vault.</Text>
  </View>;
}
