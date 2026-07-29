/**
 * One markdown configuration for every prose path in the workbench.
 *
 * `breaks: true` is the whole reason this module exists. CommonMark folds a
 * single newline into a space, which is right for a wrapped paragraph and wrong
 * for everything a record actually contains: a letterhead
 *
 *     HEADQUARTERS, DETACHMENT D
 *     1100TH USAF SPECIAL REPORTING GROUP
 *     Campbell Air Force Base
 *
 * rendered as one run-on line, an address block folded into its recipient, a
 * signature block where the name, rank and role become a sentence. The record
 * stores those as separate lines because they ARE separate lines in the source
 * document, and a reviewer judging whether the extraction is faithful is
 * looking at the shape as much as the words.
 *
 * The cost is records whose prose was hard-wrapped at extraction (a couple of
 * emails, wrapped at ~72 columns by the mail client that sent them). Those now
 * render at their original wrap - which is also what the source looked like, so
 * it is not a regression to trade for.
 */

import { marked } from "marked";

marked.use({ breaks: true });

export { marked };
