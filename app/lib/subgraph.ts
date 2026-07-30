/**
 * Discovery of the Roles modifiers attached to a Safe.
 *
 * The SDK exposes reads for a *known* modifier address but no way to find the
 * modifiers belonging to an avatar, so this issues that one query directly.
 * Runs server-side only: it keeps the endpoint out of the client and avoids
 * cross-origin requests from inside the Safe App iframe.
 */
const ENDPOINT = "https://gnosisguild.squids.live/roles:production/api/graphql";

const QUERY = `query RolesModsForAvatar($avatar: String!) {
  rolesModifiers(avatar: $avatar) {
    address
    chainId
    owner
    avatar
    target
  }
}`;

export type DiscoveredRolesMod = {
  address: string;
  chainId: number;
  owner: string;
  avatar: string;
  target: string;
};

export async function discoverRolesMods(
  avatar: string,
  signal?: AbortSignal,
): Promise<DiscoveredRolesMod[]> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: QUERY,
      variables: { avatar: avatar.toLowerCase() },
      operationName: "RolesModsForAvatar",
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(
      `The Roles indexer returned ${response.status} while looking up modifiers for this Safe.`,
    );
  }

  const payload = (await response.json()) as {
    data?: { rolesModifiers?: DiscoveredRolesMod[] };
    errors?: { message?: string }[];
  };

  const error = payload.errors?.[0];
  if (error) {
    throw new Error(error.message ?? "The Roles indexer rejected the query.");
  }

  return payload.data?.rolesModifiers ?? [];
}
