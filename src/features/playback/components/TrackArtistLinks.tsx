import { useMemo } from "react";
import type { Track } from "@/lib/media/trackTypes";
import { useAuthStore } from "@/store/authStore";
import { resolveTrackArtistRefs } from "@/features/playback/utils/playback/trackArtistRefs";
import { ResolvedArtistRefInline } from "@/ui/ResolvedArtistRefInline";
import { buildArtistDetailPath } from "@/lib/navigation/detailServerScope";

interface Props {
	track: Pick<Track, "artist" | "artistId" | "artists" | "serverId">;
	onNavigate: (to: string) => void | Promise<void>;
	/** CSS class for each artist link element (optional) */
	linkClassName?: string;
	/** CSS class for unlinked (plain-text) artist names */
	plainClassName?: string;
	/** CSS class for the outermost wrapper element (span when as='span') */
	outerClassName?: string;
	/** CSS class for the separator between artists */
	separatorClassName?: string;
}

export function TrackArtistLinks({
	track,
	onNavigate,
	linkClassName,
	plainClassName,
	outerClassName,
	separatorClassName,
}: Props) {
	const activeServerId = useAuthStore((s) => s.activeServerId ?? "");
	const refs = useMemo(() => resolveTrackArtistRefs(track), [track]);

	return (
		<ResolvedArtistRefInline
			refs={refs}
			serverId={track.serverId ?? activeServerId}
			fallbackName={track.artist}
			onGoArtist={(id) => {
				void onNavigate(
					buildArtistDetailPath(id, { serverId: track.serverId }),
				);
			}}
			as="span"
			outerClassName={outerClassName}
			linkTag="span"
			linkClassName={linkClassName}
			plainClassName={plainClassName}
			separatorClassName={separatorClassName}
		/>
	);
}
