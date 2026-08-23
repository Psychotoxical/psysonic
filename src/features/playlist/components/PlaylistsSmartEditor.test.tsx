import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PlaylistsSmartEditor from '@/features/playlist/components/PlaylistsSmartEditor';
import {
  createSmartEditorSession,
  syncSessionFromBasicFilters,
  type SmartEditorSession,
} from '@/features/playlist/utils/smartPlaylistEditor';
import type { SubsonicServerIdentity } from '@/lib/server/subsonicServerIdentity';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';

function SmartEditorHarness({
  editingSmartId,
  initialSession,
  onSaveCopy,
  serverIdentity,
  availableGenres = [],
  playlistOptions,
  serverOptions = [
    { id: 'server-a', label: 'Server A' },
    { id: 'server-b', label: 'Server B' },
  ],
}: {
  editingSmartId: string | null;
  initialSession?: SmartEditorSession;
  onSaveCopy?: () => void;
  serverIdentity?: SubsonicServerIdentity;
  availableGenres?: string[];
  playlistOptions?: Array<{ id: string; name: string }>;
  serverOptions?: Array<{ id: string; label: string }>;
}) {
  const [session, setSession] = useState(initialSession ?? createSmartEditorSession());
  const [filters, setFilters] = useState(session.filters);
  const [serverId, setServerId] = useState('server-a');

  return (
    <PlaylistsSmartEditor
      session={session}
      setSession={setSession}
      smartFilters={filters}
      setSmartFilters={action => {
        setFilters(prev => {
          const next = typeof action === 'function' ? action(prev) : action;
          setSession(current => (
            current.mode === 'basic'
              ? syncSessionFromBasicFilters(current, next)
              : { ...current, filters: { ...current.filters, name: next.name } }
          ));
          return next;
        });
      }}
      availableGenres={availableGenres}
      playlistOptions={playlistOptions}
      genreQuery=""
      setGenreQuery={vi.fn()}
      editingSmartId={editingSmartId}
      creatingSmartBusy={false}
      genresReady
      createServerId={serverId}
      setCreateServerId={setServerId}
      createServerOptions={serverOptions}
      setCreatingSmart={vi.fn()}
      setEditingSmartId={vi.fn()}
      onSave={vi.fn()}
      onCancel={vi.fn()}
      onSaveCopy={onSaveCopy}
      onPreview={async () => []}
      serverIdentity={serverIdentity}
    />
  );
}

describe('PlaylistsSmartEditor', () => {
  it('shows the target server while creating a smart playlist', () => {
    const view = renderWithProviders(<SmartEditorHarness editingSmartId={null} />);

    expect(view.getByRole('textbox', { name: 'Playlist Name' })).toBeInTheDocument();
    expect(view.getByRole('combobox', { name: 'Servers' })).toHaveTextContent('Server A');
    expect(view.getByRole('tab', { name: 'Basic' })).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps the owner server fixed while editing a smart playlist', () => {
    const view = renderWithProviders(<SmartEditorHarness editingSmartId="smart-1" />);

    expect(view.getByRole('textbox', { name: 'Playlist Name' })).toBeInTheDocument();
    expect(view.queryByRole('combobox', { name: 'Servers' })).not.toBeInTheDocument();
  });

  it('hides the owner selector when creating in single-server mode', () => {
    const view = renderWithProviders(
      <SmartEditorHarness
        editingSmartId={null}
        serverOptions={[{ id: 'server-a', label: 'Server A' }]}
      />,
    );

    expect(view.getByRole('textbox', { name: 'Playlist Name' })).toBeInTheDocument();
    expect(view.queryByRole('combobox', { name: 'Servers' })).not.toBeInTheDocument();
  });

  it('keeps Basic UX and can switch to Advanced and JSON', async () => {
    const user = userEvent.setup();
    const view = renderWithProviders(<SmartEditorHarness editingSmartId={null} />);

    expect(view.getByText('1. Basic')).toBeInTheDocument();
    expect(view.getByText('2. Genres')).toBeInTheDocument();
    expect(view.getByPlaceholderText('Artist contains…')).toBeInTheDocument();

    await user.click(view.getByRole('tab', { name: 'Advanced' }));
    expect(view.getByRole('tab', { name: 'Advanced' })).toHaveAttribute('aria-selected', 'true');
    expect(view.getByRole('combobox', { name: 'Match' })).toHaveTextContent('Match all');
    expect(view.getByRole('button', { name: 'Add rule' })).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Remove group' })).toBeNull();

    await user.click(view.getByRole('button', { name: 'Add group' }));
    const matchHeads = view.getAllByRole('combobox', { name: 'Match' });
    expect(matchHeads.length).toBeGreaterThan(1);
    expect(matchHeads[0].closest('.smart-query-group-head')?.querySelector('[aria-label="Remove group"]')).toBeNull();
    expect(view.getByRole('button', { name: 'Remove group' })).toBeInTheDocument();

    await user.click(view.getByRole('tab', { name: 'JSON' }));
    expect(view.getByRole('tab', { name: 'JSON' })).toHaveAttribute('aria-selected', 'true');
    expect((view.getByLabelText('JSON') as HTMLTextAreaElement).value).toContain('inTheRange');
    expect((view.getByLabelText('JSON') as HTMLTextAreaElement).value).toContain('"limit": 50');
    expect((view.getByLabelText('JSON') as HTMLTextAreaElement).value).toContain('+random');
  });

  it('opens JSON from the current Basic filters', async () => {
    const user = userEvent.setup();
    const view = renderWithProviders(<SmartEditorHarness editingSmartId={null} />);

    await user.type(view.getByPlaceholderText('Artist contains…'), 'Radiohead');
    await user.click(view.getByRole('tab', { name: 'JSON' }));
    expect((view.getByLabelText('JSON') as HTMLTextAreaElement).value).toContain('Radiohead');
    expect(view.queryByRole('button', { name: 'Preview JSON' })).not.toBeInTheDocument();
  });

  it('does not switch nested rules into Basic', async () => {
    const user = userEvent.setup();
    const view = renderWithProviders(
      <SmartEditorHarness
        editingSmartId="smart-1"
        initialSession={createSmartEditorSession({
          name: 'Nested',
          rules: { any: [{ contains: { title: 'live' } }, { all: [{ contains: { artist: 'A' } }] }] },
        })}
      />,
    );

    expect(view.getByRole('tab', { name: 'Advanced' })).toHaveAttribute('aria-selected', 'true');
    await user.click(view.getByRole('tab', { name: 'Basic' }));
    expect(view.getByRole('tab', { name: 'Advanced' })).toHaveAttribute('aria-selected', 'true');
    expect(view.getByText(/cannot be shown in Basic/)).toBeInTheDocument();
  });

  it('exposes Save a copy only while editing an existing playlist', async () => {
    const user = userEvent.setup();
    const onSaveCopy = vi.fn();
    const view = renderWithProviders(
      <SmartEditorHarness editingSmartId="smart-1" onSaveCopy={onSaveCopy} />,
    );

    await user.click(view.getByRole('button', { name: 'Save a copy' }));
    expect(onSaveCopy).toHaveBeenCalledTimes(1);
  });

  it('keeps invalid JSON as a draft and does not apply it', async () => {
    const user = userEvent.setup();
    const view = renderWithProviders(<SmartEditorHarness editingSmartId={null} />);

    await user.click(view.getByRole('tab', { name: 'JSON' }));
    const editor = view.getByLabelText('JSON');
    await user.clear(editor);
    await user.paste('{');
    await user.click(view.getByRole('button', { name: 'Apply to editor' }));
    expect(view.getByText(/JSON is not valid/)).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Apply to editor' })).toBeDisabled();
    expect(view.getByRole('button', { name: 'Preview matching tracks' })).toBeDisabled();
    expect(view.getByRole('button', { name: 'New Smart Playlist' })).toBeDisabled();
  });

  it('highlights the Advanced rule with an error and blocks save actions', () => {
    const view = renderWithProviders(
      <SmartEditorHarness
        editingSmartId="smart-1"
        onSaveCopy={vi.fn()}
        initialSession={createSmartEditorSession({
          name: 'Invalid',
          rules: {
            any: [
              { inPlaylist: { id: 'smart-1' } },
              { all: [{ contains: { artist: 'A' } }] },
            ],
          },
        })}
      />,
    );

    const issue = view.getByText('A smart playlist cannot reference itself directly.');
    const control = view.getByRole('combobox', { name: 'Value' });
    expect(issue).toHaveClass('smart-query-issue-error');
    expect(control).toHaveClass('smart-query-control-error');
    expect(control).toHaveAttribute('aria-invalid', 'true');
    expect(control.closest('.smart-query-row')).not.toHaveClass('smart-query-has-error');
    expect(view.getByRole('button', { name: 'Preview matching tracks' })).toBeDisabled();
    expect(view.getByRole('button', { name: 'Save a copy' })).toBeDisabled();
    expect(view.getByRole('button', { name: 'Save Smart Playlist' })).toBeDisabled();
  });

  it('highlights an opaque Advanced rule warning without blocking save', () => {
    const view = renderWithProviders(
      <SmartEditorHarness
        editingSmartId="smart-1"
        initialSession={createSmartEditorSession({
          name: 'Future',
          rules: {
            any: [
              { futureOperator: { title: 'kept' } },
              { all: [{ contains: { artist: 'A' } }] },
            ],
          },
        })}
      />,
    );

    const issue = view.getByText('Unknown operator "futureOperator" is preserved for JSON editing.');
    expect(issue).toHaveClass('smart-query-issue-warning');
    expect(view.container.querySelector('.smart-query-control-warning')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Save Smart Playlist' })).toBeEnabled();
  });

  it('highlights only the invalid date in an Advanced range', () => {
    const view = renderWithProviders(
      <SmartEditorHarness
        editingSmartId="smart-1"
        serverIdentity={{ type: 'navidrome', serverVersion: '0.63.2' }}
        initialSession={createSmartEditorSession({
          name: 'Range',
          rules: { all: [{ inTheRange: { lastplayed: ['', '2026-08-16'] } }] },
        })}
      />,
    );

    const dates = view.getAllByRole('textbox', { name: 'Date' });
    expect(dates[0]).toHaveClass('smart-query-control-error');
    expect(dates[0]).toHaveAttribute('aria-invalid', 'true');
    expect(dates[1]).not.toHaveClass('smart-query-control-error');
    expect(dates[1]).not.toHaveAttribute('aria-invalid');
    expect(view.getByText('Invalid date value for in the range.')).toBeInTheDocument();
    expect(view.queryByText(/inTheRange/)).not.toBeInTheDocument();
  });

  it('uses a typed date field instead of a trapping native calendar', () => {
    const view = renderWithProviders(
      <SmartEditorHarness
        editingSmartId="smart-1"
        initialSession={createSmartEditorSession({
          name: 'Loved',
          rules: { any: [{ after: { lastplayed: '2024-01-15' } }] },
        })}
      />,
    );

    expect(view.getByRole('tab', { name: 'Advanced' })).toHaveAttribute('aria-selected', 'true');
    const date = view.getByRole('textbox', { name: 'Date' });
    expect(date).toHaveValue('2024-01-15');
    expect(date).toHaveAttribute('placeholder', 'YYYY-MM-DD');
    expect(date).not.toHaveAttribute('type', 'date');
  });

  it('edits Boolean rule values with a dropdown', async () => {
    const user = userEvent.setup();
    const view = renderWithProviders(
      <SmartEditorHarness
        editingSmartId="smart-1"
        serverIdentity={{ type: 'navidrome', serverVersion: '0.61.0' }}
        initialSession={createSmartEditorSession({
          name: 'Loved',
          rules: { any: [{ is: { loved: true } }] },
        })}
      />,
    );

    const valueSelect = view.getByRole('combobox', { name: 'Boolean value' });
    expect(valueSelect).toHaveTextContent('True');
    await user.click(valueSelect);
    await user.click(view.getByRole('option', { name: 'False' }));
    expect(valueSelect).toHaveTextContent('False');
  });

  it('keeps pre-1950 years editable in Advanced year rules', async () => {
    const user = userEvent.setup();
    const view = renderWithProviders(
      <SmartEditorHarness
        editingSmartId="smart-1"
        initialSession={createSmartEditorSession({
          name: 'Years',
          rules: { any: [{ is: { year: 1927 } }] },
        })}
      />,
    );

    const year = view.getByRole('spinbutton', { name: 'Year' });
    expect(year).toHaveValue(1927);
    await user.clear(year);
    await user.type(year, '1808');
    expect(year).toHaveValue(1808);
  });

  it('toggles Advanced limit between a fixed count and a percentage', async () => {
    const user = userEvent.setup();
    const view = renderWithProviders(
      <SmartEditorHarness
        editingSmartId="smart-1"
        serverIdentity={{ type: 'navidrome', serverVersion: '0.61.0' }}
        initialSession={createSmartEditorSession({
          name: 'Capped',
          rules: { all: [{ contains: { title: 'live' } }], limit: 50 },
        })}
      />,
    );

    await user.click(view.getByRole('tab', { name: 'Advanced' }));
    expect(view.getByRole('button', { name: 'Fixed count' })).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Unlimited' })).toBeInTheDocument();
    expect(view.getByRole('spinbutton', { name: 'Fixed count' })).toHaveValue(50);
    await user.click(view.getByRole('button', { name: 'Percentage' }));
    expect(view.getByRole('slider', { name: 'Percentage' })).toBeInTheDocument();
    expect(view.getByRole('spinbutton', { name: 'Percentage' })).toHaveValue(25);
    expect(view.getByRole('slider', { name: 'Percentage' })).toHaveValue('25');
    await user.click(view.getByRole('button', { name: 'Fixed count' }));
    expect(view.getByRole('spinbutton', { name: 'Fixed count' })).toHaveValue(50);
    await user.click(view.getByRole('button', { name: 'Percentage' }));
    expect(view.getByRole('spinbutton', { name: 'Percentage' })).toHaveValue(25);
    fireEvent.change(view.getByRole('spinbutton', { name: 'Percentage' }), { target: { value: '0' } });
    expect(view.getByRole('spinbutton', { name: 'Percentage' })).toHaveValue(1);
    fireEvent.change(view.getByRole('spinbutton', { name: 'Percentage' }), { target: { value: '101' } });
    expect(view.getByRole('spinbutton', { name: 'Percentage' })).toHaveValue(100);
    await user.click(view.getByRole('button', { name: 'Unlimited' }));
    expect(view.queryByRole('spinbutton', { name: 'Percentage' })).toBeNull();
    await user.click(view.getByRole('button', { name: 'Percentage' }));
    expect(view.getByRole('spinbutton', { name: 'Percentage' })).toHaveValue(100);
  });

  it('offers Playlist as a Title Case field on 0.52+ servers', async () => {
    const user = userEvent.setup();
    const view = renderWithProviders(
      <SmartEditorHarness
        editingSmartId={null}
        serverIdentity={{ type: 'navidrome', serverVersion: '0.52.0' }}
        playlistOptions={[{ id: 'pl-favorites', name: 'Favorites' }]}
      />,
    );

    await user.click(view.getByRole('tab', { name: 'Advanced' }));
    const field = view.getAllByRole('combobox', { name: 'Field' })[0];
    await user.click(field);
    await user.type(field, 'play');
    await user.click(view.getByRole('option', { name: 'Playlist' }));
    expect(field).toHaveValue('Playlist');
    expect(view.getByText('in playlist')).toBeInTheDocument();

    const value = view.getByRole('combobox', { name: 'Value' });
    await user.click(value);
    await user.click(view.getByRole('option', { name: 'Favorites' }));
    expect(value).toHaveValue('Favorites');
  });

  it('shows an existing playlist membership rule with the selected playlist name', () => {
    const view = renderWithProviders(
      <SmartEditorHarness
        editingSmartId="smart-1"
        serverIdentity={{ type: 'navidrome', serverVersion: '0.52.0' }}
        playlistOptions={[
          { id: 'pl-favorites', name: 'Favorites' },
          { id: 'pl-deep', name: 'Deep Cuts' },
        ]}
        initialSession={createSmartEditorSession({
          name: 'From Favorites',
          rules: { all: [{ inPlaylist: { id: 'pl-favorites' } }] },
        })}
      />,
    );

    expect(view.getByDisplayValue('Playlist')).toBeInTheDocument();
    expect(view.getByRole('combobox', { name: 'Value' })).toHaveValue('Favorites');
    expect(view.getByText('in playlist')).toBeInTheDocument();
  });

  it('applies a selected playlist into an in-playlist rule', async () => {
    const user = userEvent.setup();
    const view = renderWithProviders(
      <SmartEditorHarness
        editingSmartId="smart-1"
        serverIdentity={{ type: 'navidrome', serverVersion: '0.52.0' }}
        playlistOptions={[
          { id: 'pl-favorites', name: 'Favorites' },
          { id: 'pl-deep', name: 'Deep Cuts' },
        ]}
        initialSession={createSmartEditorSession({
          name: 'From Favorites',
          rules: { all: [{ inPlaylist: { id: '' } }] },
        })}
      />,
    );

    const value = view.getByRole('combobox', { name: 'Value' });
    await user.click(value);
    await user.type(value, 'deep');
    await user.click(view.getByRole('option', { name: 'Deep Cuts' }));
    expect(value).toHaveValue('Deep Cuts');
  });

  it('suggests existing genres in Advanced rule values', async () => {
    const user = userEvent.setup();
    const view = renderWithProviders(
      <SmartEditorHarness
        editingSmartId="smart-1"
        availableGenres={['Rock', 'Jazz']}
        initialSession={createSmartEditorSession({
          name: 'Genres',
          rules: { all: [{ is: { genre: '' } }] },
        })}
      />,
    );

    const value = view.getByRole('combobox', { name: 'Value' });
    await user.click(value);
    await user.type(value, 'ja');
    await user.click(view.getByRole('option', { name: 'Jazz' }));
    expect(value).toHaveValue('Jazz');
  });

  it('duplicates a rule and a nested group', async () => {
    const user = userEvent.setup();
    const view = renderWithProviders(
      <SmartEditorHarness
        editingSmartId="smart-1"
        initialSession={createSmartEditorSession({
          name: 'Dup',
          rules: {
            all: [
              { contains: { title: 'live' } },
              { any: [{ contains: { artist: 'A' } }] },
            ],
          },
        })}
      />,
    );

    expect(view.getAllByRole('button', { name: 'Duplicate rule' })).toHaveLength(2);
    await user.click(view.getAllByRole('button', { name: 'Duplicate rule' })[0]);
    expect(view.getAllByRole('button', { name: 'Duplicate rule' })).toHaveLength(3);
    expect(view.getAllByDisplayValue('live')).toHaveLength(2);

    await user.click(view.getByRole('button', { name: 'Duplicate group' }));
    expect(view.getAllByRole('button', { name: 'Duplicate group' })).toHaveLength(2);
    expect(view.getAllByDisplayValue('A')).toHaveLength(2);
  });

  it('caps rating fields at 0-5 and keeps range inputs compact', async () => {
    const user = userEvent.setup();
    const view = renderWithProviders(
      <SmartEditorHarness
        editingSmartId="smart-1"
        serverIdentity={{ type: 'navidrome', serverVersion: '0.61.0' }}
        initialSession={createSmartEditorSession({
          name: 'Ratings',
          rules: { all: [{ inTheRange: { albumrating: [0, 5] } }] },
        })}
      />,
    );

    const inputs = view.getAllByRole('spinbutton').filter(input => input.getAttribute('max') === '5');
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toHaveAttribute('min', '0');
    expect(inputs[1]).toHaveValue(5);
    await user.clear(inputs[1]);
    await user.type(inputs[1], '9');
    expect(inputs[1]).toHaveValue(5);
  });

  it('uses a day count for in-the-last date rules', () => {
    const view = renderWithProviders(
      <SmartEditorHarness
        editingSmartId="smart-1"
        initialSession={createSmartEditorSession({
          name: 'Recent',
          rules: { any: [{ inTheLast: { lastplayed: 14 } }] },
        })}
      />,
    );

    expect(view.getByDisplayValue('14')).toHaveAttribute('type', 'number');
    expect(view.getByDisplayValue('14')).toHaveAttribute('min', '1');
    expect(view.queryByRole('textbox', { name: 'Date' })).not.toBeInTheDocument();
  });

  it('uses typed number inputs for numeric Advanced rules', () => {
    const view = renderWithProviders(
      <SmartEditorHarness
        editingSmartId="smart-1"
        initialSession={createSmartEditorSession({
          name: 'Plays',
          rules: { any: [{ gt: { playcount: 12 } }] },
        })}
      />,
    );

    expect(view.getByRole('tab', { name: 'Advanced' })).toHaveAttribute('aria-selected', 'true');
    expect(view.getByDisplayValue('12')).toHaveAttribute('type', 'number');
  });

  it('warns about version-gated JSON paths without changing the document', async () => {
    const user = userEvent.setup();
    const view = renderWithProviders(
      <SmartEditorHarness
        editingSmartId="smart-1"
        serverIdentity={{ type: 'navidrome', serverVersion: '0.56.0' }}
        initialSession={createSmartEditorSession({
          name: 'Future',
          rules: {
            all: [{ contains: { title: 'live' } }],
            sort: '-lastplayed,title',
            clientMetadata: { kept: true },
          },
        })}
      />,
    );

    await user.click(view.getByRole('tab', { name: 'JSON' }));
    expect(view.getByText(/Unsupported or unknown paths/)).toBeInTheDocument();
    expect((view.getByLabelText('JSON') as HTMLTextAreaElement).value).toContain('clientMetadata');
  });
});
