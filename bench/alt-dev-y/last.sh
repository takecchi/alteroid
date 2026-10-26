#!/bin/bash
for n in "$@"; do
  echo "=================== #$n"
  gh issue view "$n" -R takecchi/alteroid --json comments --jq '.comments[-1].body'
done
