### Fixed
- scripts/strata-vision.sh: portable chmod for settings.env.tmp (GNU stat -c %a, BSD stat -f %Lp, fallback 600)
- scripts/apply.sh: fix temp config leak when overrides used by tracking tmp_config separately and cleaning up in final EXIT trap