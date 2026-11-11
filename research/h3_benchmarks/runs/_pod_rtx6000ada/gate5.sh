cd /opt/dramaclaw
while ! grep -q ALL_DONE /opt/gate34b.log; do sleep 10; done
PY=/opt/venv/bin/python; D=previs_h3_test/scripts; K=$D/skits/who_has_it_worse.json
tm() { echo "[$(date -u +%T)] $*"; }
tm "gen 2k draft0.3 lbh shot0"
$PY $D/latent_refine_local.py gen g5_lbh_d03_2k --target 2k --draft-mp 0.3 --upscaler lbh --prompt-file $K --shot 0 --note "H1 draft0.3 -> 2K one graph, lbh"
tm "gen 2k draft0.3 bislerp shot0"
$PY $D/latent_refine_local.py gen g5_bislerp_d03_2k --target 2k --draft-mp 0.3 --upscaler bislerp --prompt-file $K --shot 0 --note "H1 draft0.3 -> 2K one graph, bislerp"
tm GATE5_DONE
