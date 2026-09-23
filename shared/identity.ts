/**
 * A package name as a person would write it: `acme-ops-agent` reads as
 * `Acme Ops Agent`.
 *
 * Its own module so the transform can be tested against literals. The
 * config applies it to whatever `package.json` says, which differs in every
 * scaffold, so a test that pinned the config's output to this repository's
 * name would fail in every project made from it.
 */
export function titleFromName(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}`)
    .join(" ");
}
