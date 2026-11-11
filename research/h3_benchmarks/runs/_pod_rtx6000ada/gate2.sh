cd /opt/dramaclaw
PY=/opt/venv/bin/python; S=previs_h3_test/scripts/latent_refine_local.py; K=previs_h3_test/scripts/skits/who_has_it_worse.json
$PY $S direct g2_direct768 --target 768p --prompt-file $K --shot 0 --note "gate2 direct 768p"
$PY $S gen g2_lbh_d03 --target 768p --draft-mp 0.3 --upscaler lbh --prompt-file $K --shot 0 --note "gate2 draft0.3 lbh"
$PY $S gen g2_bislerp_d03 --target 768p --draft-mp 0.3 --upscaler bislerp --prompt-file $K --shot 0 --note "gate2 draft0.3 bislerp (two_stage-like)"
echo GATE2_DONE
