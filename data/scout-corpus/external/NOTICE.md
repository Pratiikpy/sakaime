# deepset-prompt-injections-test.json

Source: the `test` split of the `deepset/prompt-injections` dataset on Hugging Face (https://huggingface.co/datasets/deepset/prompt-injections), Apache License 2.0, retrieved 2026-10-27 through the Hugging Face datasets-server rows API.

Change made: the 116 rows were written out as one JSON array of `{ id, text, label }` objects, with the `id` added (`deepset-test-000` onward). The text and labels are unchanged. Label 1 is an injection, label 0 is benign.

Use: an independent sanity check on the generic recall and false-block rate of the Scout guard (`evals/scout/run.ts`). The set is generic, partly German, and counts some role-play prompts as injections that Sakaime lets through on purpose. It is not part of the Sakaime corpus and is not used to tune any rule.
