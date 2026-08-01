import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/helpers/renderWithProviders";

const resolveArtistIds = vi.hoisted(() => vi.fn());

vi.mock("@/generated/bindings", () => ({
	commands: { libraryResolveArtistIds: resolveArtistIds },
}));
vi.mock("@/lib/api/coverCache", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/api/coverCache")>()),
	librarySqlServerId: (id: string) => id,
}));

import { __resetArtistIdResolveCacheForTests } from "@/lib/library/artistIdResolve";
import { TrackArtistLinks } from "./TrackArtistLinks";

describe("TrackArtistLinks", () => {
	beforeEach(() => {
		__resetArtistIdResolveCacheForTests();
		resolveArtistIds.mockReset();
	});

	it("splits, resolves, and keyboard-navigates a legacy joined credit", async () => {
		resolveArtistIds.mockResolvedValue({ status: "ok", data: ["guest-id"] });
		const onNavigate = vi.fn();

		renderWithProviders(
			<TrackArtistLinks
				track={{
					artist: "Primary feat. Guest",
					artistId: "primary-id",
					serverId: "srv-owner",
				}}
				onNavigate={onNavigate}
			/>,
		);

		await waitFor(() =>
			expect(resolveArtistIds).toHaveBeenCalledWith("srv-owner", ["Guest"]),
		);
		expect(screen.getByRole("link", { name: "Primary" })).toBeTruthy();

		const guest = await screen.findByRole("link", { name: "Guest" });
		fireEvent.keyDown(guest, { key: "Enter" });
		expect(onNavigate).toHaveBeenCalledWith(
			"/artist/guest-id?server=srv-owner",
		);
	});

	it("keeps structured OpenSubsonic artists authoritative", () => {
		const onNavigate = vi.fn();

		renderWithProviders(
			<TrackArtistLinks
				track={{
					artist: "Primary feat. Guest",
					artistId: "legacy-primary-id",
					artists: [
						{ id: "primary-id", name: "Primary" },
						{ id: "guest-id", name: "Guest" },
					],
					serverId: "srv-owner",
				}}
				onNavigate={onNavigate}
			/>,
		);

		expect(screen.getByRole("link", { name: "Primary" })).toBeTruthy();
		expect(screen.getByRole("link", { name: "Guest" })).toBeTruthy();
		expect(resolveArtistIds).not.toHaveBeenCalled();
	});
});
