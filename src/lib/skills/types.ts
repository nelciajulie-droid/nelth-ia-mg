/**
 * Domain-expertise skills written for this platform (the "library"),
 * complementary to the Anthropic agent-skills archive (the "catalog").
 *
 * A Skill follows the Claude.ai Agent-Skills structure: the `description`
 * (with `keywords`) is the always-visible router metadata (manifest level 1
 * of progressive disclosure), while `body` is the full instruction pack
 * injected only when the task matches (level 2).
 */
export interface Skill {
  /** kebab-case unique id — must not collide with the catalog names. */
  name: string;
  /** <= 900 chars — the manifest line the model (and the pre-selector) routes on. */
  description: string;
  /** lowercase, accent-free French + English trigger words. */
  keywords: string[];
  /** Full instructions injected when the skill is selected. */
  body: string;
}
