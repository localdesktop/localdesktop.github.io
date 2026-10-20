import * as vscode from "vscode";
import type { GitHubClient } from "../github/client";
import type { PrState } from "./store";
import { formatVersion, LABEL_DESCRIPTIONS, nextLabels, predictVersion, RELEASE_LABELS, type Version } from "./versioning";

interface LabelItem extends vscode.QuickPickItem {
  value: string;
}

/** QuickPick showing each label's bump and the version it would release; applies it in one call. */
export async function pickReleaseLabel(c: GitHubClient, st: PrState, mainVersion: Version | undefined, tags: readonly string[]): Promise<string | undefined> {
  const current = st.releaseLabels[0];
  const items: LabelItem[] = Object.entries(RELEASE_LABELS).map(([label, level]) => {
    const v = mainVersion ? predictVersion(mainVersion, tags, label) : undefined;
    return {
      label: `${label === current ? "$(check) " : ""}${label}`,
      description: level ? `${level} → v${v ? formatVersion(v) : "?"}` : "no app release",
      detail: LABEL_DESCRIPTIONS[label],
      value: label,
    };
  });
  const pick = await vscode.window.showQuickPick(items, {
    title: `Release label for #${st.pr.number}`,
    placeHolder: st.nonAppOnly ? "This PR only touches the website/tooling; a label isn't required." : "Exactly one release label is required to merge",
  });
  if (!pick || pick.value === current) return undefined;
  const labels = nextLabels(
    st.pr.labels.map((l) => l.name),
    pick.value,
  );
  await c.rest.issues.setLabels({ ...c.params, issue_number: st.pr.number, labels });
  return pick.value;
}
