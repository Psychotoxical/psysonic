import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/helpers/renderWithProviders";

const emitMock = vi.hoisted(() => vi.fn());
const resolveArtistIds = vi.hoisted(() => vi.fn());

// The global setup already stubs @tauri-apps/api/event; re-mock here so the
// test can assert on the exact `mini:navigate` payload.
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(),
	once: vi.fn(async () => () => {}),
	emit: emitMock,
}));
vi.mock("@/generated/bindings", () => ({
	commands: { libraryResolveArtistIds: resolveArtistIds },
}));
vi.mock("@/lib/api/coverCache", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/api/coverCache")>()),
	librarySqlServerId: (id: string) => id,
}));

import { __resetArtistIdResolveCacheForTests } from "@/lib/library/artistIdResolve";
import { MiniMeta } from "./MiniMeta";
import type { MiniTrackInfo } from "@/features/miniPlayer/utils/miniTrackInfo";

function renderMini(track: MiniTrackInfo) {
	return renderWithProviders(
		<MiniMeta track={track} miniCoverSrc="" miniCoverKey="" />,
	);
}

describe("MiniMeta artist credits", () => {
	beforeEach(() => {
		__resetArtistIdResolveCacheForTests();
		resolveArtistIds.mockReset();
		emitMock.mockReset();
	});

	it("splits a legacy joined credit, resolves the guest, and navigates via mini:navigate on Enter", async () => {
		resolveArtistIds.mockResolvedValue({ status: "ok", data: ["guest-id"] });

		renderMini({
			id: "track-1",
			title: "Track",
			artist: "Primary feat. Guest",
			artistId: "primary-id",
			serverId: "srv-owner",
			album: "Album",
		});

		await waitFor(() =>
			expect(resolveArtistIds).toHaveBeenCalledWith("srv-owner", ["Guest"]),
		);
		expect(screen.getByRole("link", { name: "Primary" })).toBeTruthy();

		const guest = await screen.findByRole("link", { name: "Guest" });
		fireEvent.keyDown(guest, { key: "Enter" });
		expect(emitMock).toHaveBeenCalledWith("mini:navigate", {
			to: "/artist/guest-id?server=srv-owner",
		});
	});

	it("keeps structured OpenSubsonic artists authoritative", () => {
		renderMini({
			id: "track-1",
			title: "Track",
			artist: "Primary feat. Guest",
			artistId: "legacy-primary-id",
			artists: [
				{ id: "primary-id", name: "Primary" },
				{ id: "guest-id", name: "Guest" },
			],
			serverId: "srv-owner",
			album: "Album",
		});

		expect(screen.getByRole("link", { name: "Primary" })).toBeTruthy();
		expect(screen.getByRole("link", { name: "Guest" })).toBeTruthy();
		expect(resolveArtistIds).not.toHaveBeenCalled();
	});
});
