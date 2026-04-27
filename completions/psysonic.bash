# bash completion for Psysonic (see `psysonic --help`).
# Install: source /path/to/completions/psysonic.bash
# Optional: jq + prior `psysonic --player audio-device list` for device name completion.
#
# Uses no `mapfile` so bash 3.2 (macOS default) works.
#
# compopt is bash-only (programmable completion). Guard so sourcing this file
# under zsh or plain sh does not print "command not found: compopt".

_psysonic_compopt() {
  command -v compopt &>/dev/null || return 0
  compopt "$@" 2>/dev/null || return 0
}

_psysonic_compreply_from_compgen() {
  # $1 = compgen -W word list, $2 = current word
  COMPREPLY=()
  local line
  while IFS= read -r line; do
    [[ -n $line ]] && COMPREPLY+=("$line")
  done < <(compgen -W "$1" -- "$2")
}

_psysonic_audio_device_json() {
  local f
  if [[ -n ${XDG_RUNTIME_DIR:-} ]]; then
    f="$XDG_RUNTIME_DIR/psysonic-cli-audio-devices.json"
    [[ -r $f ]] && { printf '%s' "$f"; return; }
  fi
  f="${TMPDIR:-/tmp}/psysonic-cli-audio-devices.json"
  [[ -r $f ]] && printf '%s' "$f"
}

_psysonic_library_json() {
  local f
  if [[ -n ${XDG_RUNTIME_DIR:-} ]]; then
    f="$XDG_RUNTIME_DIR/psysonic-cli-library.json"
    [[ -r $f ]] && { printf '%s' "$f"; return; }
  fi
  f="${TMPDIR:-/tmp}/psysonic-cli-library.json"
  [[ -r $f ]] && printf '%s' "$f"
}

_psysonic_snapshot_json() {
  local f
  if [[ -n ${XDG_RUNTIME_DIR:-} ]]; then
    f="$XDG_RUNTIME_DIR/psysonic-cli-snapshot.json"
    [[ -r $f ]] && { printf '%s' "$f"; return; }
  fi
  f="${TMPDIR:-/tmp}/psysonic-cli-snapshot.json"
  [[ -r $f ]] && printf '%s' "$f"
}

_psysonic_complete() {
  local cur
  cur="${COMP_WORDS[COMP_CWORD]}"
  local prev=""
  (( COMP_CWORD > 0 )) && prev="${COMP_WORDS[COMP_CWORD-1]}"

  if [[ $prev == --tail ]]; then
    _psysonic_compopt -o default
    COMPREPLY=()
    return
  fi

  local i pidx=0
  for (( i = 1; i < COMP_CWORD; i++ )); do
    [[ ${COMP_WORDS[i]} == --player ]] && pidx=$i
  done

  if (( pidx == 0 )); then
    local has_logs=0
    for (( i = 1; i < COMP_CWORD; i++ )); do
      [[ ${COMP_WORDS[i]} == --logs ]] && has_logs=1
    done
    if [[ ${COMP_WORDS[1]} == completions && COMP_CWORD -eq 2 ]]; then
      _psysonic_compreply_from_compgen 'help bash zsh' "$cur"
      return
    fi
    if (( has_logs )); then
      _psysonic_compreply_from_compgen '--tail -f --follow' "$cur"
    else
      _psysonic_compreply_from_compgen '--help --version --info --json --quiet --logs --player completions' "$cur"
    fi
    return
  fi

  local -a sub=()
  for (( i = pidx + 1; i < COMP_CWORD; i++ )); do
    sub+=("${COMP_WORDS[i]}")
  done
  local n=${#sub[@]}

  if (( n == 0 )); then
    _psysonic_compreply_from_compgen 'next prev play pause stop seek volume shuffle repeat mute unmute star unstar rating reload audio-device library server search mix' "$cur"
    return
  fi

  case ${sub[0]} in
    audio-device)
      if (( n == 1 )); then
        _psysonic_compreply_from_compgen 'list set' "$cur"
      elif [[ ${sub[1]} == set ]] && (( n == 2 )); then
        COMPREPLY=()
        local jf d
        jf="$(_psysonic_audio_device_json)"
        if [[ -n $jf ]] && command -v jq &>/dev/null; then
          while IFS= read -r d; do
            [[ -n $d && $d == "$cur"* ]] && COMPREPLY+=("$d")
          done < <(jq -r '.devices[]? | select(type == "string")' "$jf" 2>/dev/null)
        fi
        while IFS= read -r line; do
          [[ -n $line ]] && COMPREPLY+=("$line")
        done < <(compgen -W 'default' -- "$cur")
        ((${#COMPREPLY[@]})) && _psysonic_compopt -o filenames
      fi
      ;;
    library)
      if (( n == 1 )); then
        _psysonic_compreply_from_compgen 'list set' "$cur"
      elif [[ ${sub[1]} == set ]] && (( n == 2 )); then
        COMPREPLY=()
        local jf id line
        jf="$(_psysonic_library_json)"
        if [[ -n $jf ]] && command -v jq &>/dev/null; then
          while IFS= read -r id; do
            [[ -n $id && $id == "$cur"* ]] && COMPREPLY+=("$id")
          done < <(jq -r '.folders[]? | select(.id != null) | .id | tostring' "$jf" 2>/dev/null)
        fi
        while IFS= read -r line; do
          [[ -n $line ]] && COMPREPLY+=("$line")
        done < <(compgen -W 'all' -- "$cur")
        ((${#COMPREPLY[@]})) && _psysonic_compopt -o filenames
      fi
      ;;
    mix)
      (( n == 1 )) && _psysonic_compreply_from_compgen 'append new' "$cur"
      ;;
    server)
      if (( n == 1 )); then
        _psysonic_compreply_from_compgen 'list set' "$cur"
      elif [[ ${sub[1]} == set ]] && (( n == 2 )); then
        COMPREPLY=()
        local jf sid
        jf="$(_psysonic_snapshot_json)"
        if [[ -n $jf ]] && command -v jq &>/dev/null; then
          while IFS= read -r sid; do
            [[ -n $sid && $sid == "$cur"* ]] && COMPREPLY+=("$sid")
          done < <(jq -r '.servers[]? | select(.id != null) | .id | tostring' "$jf" 2>/dev/null)
        fi
        ((${#COMPREPLY[@]})) && _psysonic_compopt -o filenames
      fi
      ;;
    search)
      if (( n == 1 )); then
        _psysonic_compreply_from_compgen 'track album artist' "$cur"
      elif (( n >= 2 )); then
        _psysonic_compopt -o default
        COMPREPLY=()
      fi
      ;;
    repeat)
      (( n == 1 )) && _psysonic_compreply_from_compgen 'off all one' "$cur"
      ;;
    rating)
      (( n == 1 )) && _psysonic_compreply_from_compgen '0 1 2 3 4 5' "$cur"
      ;;
    seek|volume)
      if (( n == 1 )); then
        _psysonic_compopt -o default
        COMPREPLY=()
      fi
      ;;
    play)
      if (( n == 1 )); then
        _psysonic_compopt -o default
        COMPREPLY=()
      fi
      ;;
  esac
}

complete -F _psysonic_complete psysonic
