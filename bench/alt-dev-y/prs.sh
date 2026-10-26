#!/bin/bash
for n in 5264 5227 5196 5195 5186 5182 5180 5176 5175 5170 5168 5164 5162 5160 5157 5155 5140 5138 5136 5134 5130 5126 5125 5124 5117 5115 5089 5022 4493 4128 2671 2352 1311; do
  echo "== #$n"
  gh pr list -R takecchi/alteroid --search "$n" --state all --limit 10 --json number,state,title,headRefName --jq '.[] | "\(.number) \(.state) \(.headRefName) \(.title)"'
done
