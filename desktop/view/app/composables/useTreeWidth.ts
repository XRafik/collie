// The Diff tree's chosen width, held by Desktop for as long as it runs and shared by every
// record.

import { ref } from "vue";
import { TREE } from "../../../src/shared/diff-view";

const chosen = ref<number>(TREE.paneStart);

export const useTreeWidth = () => chosen;
