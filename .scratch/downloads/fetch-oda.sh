#!/usr/bin/env bash
set -u

DEST="/c/Users/q4444/Downloads/ODAFileConverter_QT6_vc16_amd64dll_27.10.msi"
TMP="/c/Users/q4444/Downloads/oda_dl"
BASE="https://www.opendesign.com/guestfiles/get?filename=ODAFileConverter_QT6_vc16_amd64dll.msi"
PROXY="http://127.0.0.1:7897"
TOTAL=33656320
N=24

mkdir -p "$TMP"
rm -f "$TMP"/part.*

CHUNK=$(( (TOTAL + N - 1) / N ))

signed_url() {
  curl -sS -o /dev/null -w "%{redirect_url}" --max-time 25 -x "$PROXY" "$BASE" 2>/dev/null
}

fetch_part() {
  local idx=$1
  local start=$(( idx * CHUNK ))
  local end=$(( start + CHUNK - 1 ))
  if (( end >= TOTAL )); then end=$(( TOTAL - 1 )); fi
  local want=$(( end - start + 1 ))
  local part="$TMP/part.$(printf '%02d' "$idx")"
  local attempt=0
  while :; do
    local have=0
    if [ -f "$part" ]; then have=$(stat -c %s "$part"); fi
    if (( have >= want )); then
      echo "part $idx ok ($want bytes)"
      return 0
    fi
    attempt=$(( attempt + 1 ))
    if (( attempt > 10 )); then
      echo "part $idx FAILED ($have/$want bytes)"
      return 1
    fi
    local u
    u=$(signed_url)
    if [ -z "$u" ]; then
      sleep 2
      continue
    fi
    curl -sS --max-time 180 -r $(( start + have ))-"$end" "$u" >> "$part" 2>/dev/null
    if [ -f "$part" ]; then
      local now
      now=$(stat -c %s "$part")
      if (( now > want )); then
        truncate -s "$want" "$part"
      fi
    fi
  done
}

fails=0
for i in $(seq 0 $(( N - 1 ))); do
  fetch_part "$i" &
done
wait
for i in $(seq 0 $(( N - 1 ))); do
  p="$TMP/part.$(printf '%02d' "$i")"
  if [ ! -f "$p" ]; then fails=$((fails+1)); continue; fi
done

if (( fails > 0 )); then
  echo "RESULT: FAILED parts=$fails"
  exit 1
fi

cat "$TMP"/part.* > "$DEST"
SIZE=$(stat -c %s "$DEST")
echo "RESULT: wrote $DEST bytes=$SIZE expected=$TOTAL"
if (( SIZE != TOTAL )); then
  echo "RESULT: SIZE_MISMATCH"
  exit 2
fi
