from proof_target import median


def test_median_odd_unsorted():
    assert median([5.0, 1.0, 3.0]) == 3.0
