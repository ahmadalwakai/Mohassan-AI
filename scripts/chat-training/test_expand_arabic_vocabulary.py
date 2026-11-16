import importlib.util
from collections import Counter
from pathlib import Path

import pytest

spec=importlib.util.spec_from_file_location("expand_arabic_vocabulary",Path(__file__).with_name("expand_arabic_vocabulary.py"))
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def base_tokenizer():
    # An old English merge and one existing Arabic character merge.
    return m.ByteBPETokenizer([(ord('h'),ord('e')),(0xd8,0xa7)],target_vocab_size=8192)


def test_append_ranks_preserves_arbitrary_english_and_arabic_roundtrips():
    old=base_tokenizer()
    counts=Counter({" العربية":50,"العربية":30,"العالم":20,"مرحبا":20,"hello":1000})
    new,report=m.append_merges(old,counts,target=16384,min_frequency=2)
    assert new.vocab_size>old.vocab_size
    assert new.to_dict()['merges'][:len(old.to_dict()['merges'])]==old.to_dict()['merges']
    assert all(old.token_bytes(i)==new.token_bytes(i) for i in range(old.vocab_size))
    for text in ('hello, here are 123 apples.','Café and naïve résumé.', 'العربية حول العالم', 'مرحبا بالناس'):
        assert new.decode_bytes(new.encode(text)).decode('utf-8')==text
        if not m.ARABIC.search(text): assert old.encode(text)==new.encode(text)
    assert len(new.encode(' العربية'))<len(old.encode(' العربية'))
    assert report['old_ids_and_merge_ranks_preserved']


def test_weighted_learning_is_deterministic_for_counter_insertion_order():
    old=base_tokenizer()
    a=Counter({' سلام':30,' كتاب':20,' الناس':10})
    b=Counter(dict(reversed(list(a.items()))))
    one,_=m.append_merges(old,a,target=16384)
    two,_=m.append_merges(old,b,target=16384)
    assert one.identity==two.identity


def test_token_length_bound_and_no_ascii_new_merges():
    old=base_tokenizer()
    new,_=m.append_merges(old,Counter({'الاستراتيجيات':50,'hello':10000}),target=16384,max_token_bytes=4)
    for token in range(old.vocab_size,new.vocab_size):
        data=new.token_bytes(token)
        assert len(data)<=4
        assert any(0xd8<=byte<=0xdb for byte in data)


def test_transplant_preserves_old_weights_and_initializes_from_original_rows():
    import torch
    from execution_model.model import ExecutionModel
    old=base_tokenizer()
    new,_=m.append_merges(old,Counter({' العربية':50,'مرحبا':30}),target=16384)
    cfg=m.ModelConfig(vocab_size=old.vocab_size,hidden_size=16,intermediate_size=32,num_layers=1,num_heads=2,max_context_length=32)
    before=ExecutionModel(cfg).state_dict()
    after,cfg2=m.expand_weights(before,cfg,old,new)
    assert cfg2.vocab_size==new.vocab_size
    assert torch.equal(before['token_embedding.weight'],after['token_embedding.weight'][:old.vocab_size])
    for key in before:
        if key!='token_embedding.weight':assert torch.equal(before[key],after[key])
    i=new.vocab_size-1
    parts=old.encode_bytes(new.token_bytes(i))
    lengths=torch.tensor([len(old.token_bytes(j)) for j in parts],dtype=torch.float32)
    expected=(before['token_embedding.weight'][parts]*lengths[:,None]).sum(0)/lengths.sum()
    assert torch.equal(expected,after['token_embedding.weight'][i])
    previous_threads=torch.get_num_threads()
    torch.set_num_threads(1)
    try:
        a,b=ExecutionModel(cfg).eval(),ExecutionModel(cfg2).eval()
        a.load_state_dict(before);b.load_state_dict(after)
        ids=torch.tensor([[12,27,91]])
        with torch.no_grad():
            assert torch.allclose(a(ids).logits,b(ids).logits[:,:,:old.vocab_size],rtol=1e-6,atol=1e-6)
    finally:torch.set_num_threads(previous_threads)


def test_validation_named_file_cannot_train_merges(tmp_path):
    file=tmp_path/'ar.validation.jsonl'
    file.write_text('{"text":"العربية","language":"ar"}\n',encoding='utf-8')
    with pytest.raises(ValueError,match='training file'):m.word_counts(file,1000)
