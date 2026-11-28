/**
 * The letters on the round avatar: the first letter of each word of the
 * display name, at most two. With no name set, the caller passes the
 * localized default name ("Reader" / 「读者」), so the avatar matches the name
 * shown beside it instead of always reading "R".
 */
export function avatarInitials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => Array.from(part)[0])
    .join("")
    .toUpperCase();
}
