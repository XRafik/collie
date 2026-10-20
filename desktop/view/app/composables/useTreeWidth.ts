// The Diff tree's chosen width, shared by every record until Desktop quits.

import { ref } from "vue";
import { TREE } from "../../../src/shared/diff-view";

const chosen = ref<number>(TREE.paneStart);

export const useTreeWidth = () => chosen;
