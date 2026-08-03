import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';

const mocks = vi.hoisted(() => ({
  createForServer: vi.fn(),
  fetchUrlBytes: vi.fn(),
  getForServer: vi.fn(),
  getTop: vi.fn(),
  search: vi.fn(),
  uploadBytesForServer: vi.fn(),
}));

vi.mock('@/lib/api/subsonicRadio', () => ({
  createInternetRadioStationForServer: mocks.createForServer,
  fetchUrlBytes: mocks.fetchUrlBytes,
  getInternetRadioStationsForServer: mocks.getForServer,
  getTopRadioStations: mocks.getTop,
  searchRadioBrowser: mocks.search,
  uploadRadioCoverArtBytesForServer: mocks.uploadBytesForServer,
}));

import RadioDirectoryModal from './RadioDirectoryModal';

describe('RadioDirectoryModal owner-scoped creation', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.getTop.mockResolvedValue([{
      stationuuid: 'directory-id',
      name: 'Directory Station',
      url: 'https://shared.test/live',
      favicon: 'https://images.test/directory.png',
      tags: '',
    }]);
    mocks.createForServer.mockResolvedValue(undefined);
    mocks.getForServer.mockResolvedValue([
      {
        id: 'existing-id',
        serverId: 'srv-owner',
        name: 'Existing Station',
        streamUrl: 'https://shared.test/live',
      },
      {
        id: 'created-id',
        serverId: 'srv-owner',
        name: 'Directory Station',
        streamUrl: 'https://shared.test/live',
      },
    ]);
    mocks.fetchUrlBytes.mockResolvedValue([[1, 2, 3], 'image/png']);
    mocks.uploadBytesForServer.mockResolvedValue(undefined);
  });

  it('uploads the directory favicon to the station matching both name and stream URL', async () => {
    const onAdded = vi.fn();
    const view = renderWithProviders(
      <RadioDirectoryModal
        initialServerId="srv-owner"
        serverOptions={[{ id: 'srv-owner', label: 'Owner' }]}
        onMutationStart={vi.fn()}
        onClose={vi.fn()}
        onAdded={onAdded}
      />,
    );

    expect(view.queryByRole('combobox', { name: 'Servers' })).not.toBeInTheDocument();
    fireEvent.click(await view.findByText('Directory Station'));

    await waitFor(() => expect(mocks.uploadBytesForServer).toHaveBeenCalledWith(
      'srv-owner',
      'created-id',
      [1, 2, 3],
      'image/png',
    ));
    expect(mocks.uploadBytesForServer).not.toHaveBeenCalledWith(
      'srv-owner',
      'existing-id',
      expect.anything(),
      expect.anything(),
    );
    expect(onAdded).toHaveBeenCalledOnce();
  });

  it('adds to the server selected inside the directory modal', async () => {
    const user = userEvent.setup();
    const onMutationStart = vi.fn();
    const onAdded = vi.fn();
    const view = renderWithProviders(
      <RadioDirectoryModal
        initialServerId="srv-a"
        serverOptions={[
          { id: 'srv-a', label: 'Server A' },
          { id: 'srv-b', label: 'Server B' },
        ]}
        onMutationStart={onMutationStart}
        onClose={vi.fn()}
        onAdded={onAdded}
      />,
    );

    const serverSelect = view.getByRole('combobox', { name: 'Servers' });
    expect(serverSelect).toHaveTextContent('Server A');
    await user.click(serverSelect);
    await user.click(view.getByRole('option', { name: 'Server B' }));
    await user.click(await view.findByText('Directory Station'));

    await waitFor(() => expect(mocks.createForServer).toHaveBeenCalledWith(
      'srv-b',
      'Directory Station',
      'https://shared.test/live',
    ));
    expect(onMutationStart).toHaveBeenCalledWith('srv-b');
    expect(onAdded).toHaveBeenCalledWith('srv-b');
  });
});
