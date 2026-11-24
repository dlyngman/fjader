"""How a widget ships its tables: snapshots named by their content, left out of
the blob once a browser confirmed it has them, and sent back when it asks."""

import json

import pytest

import fjader as fj
from fjader import _display
from fjader._display import make_widget


@pytest.fixture(autouse=True)
def _no_confirmed_tables():
    """Each test starts in a kernel no browser has confirmed tables for."""
    _display._confirmed.clear()
    yield
    _display._confirmed.clear()


def _rows(ipc: bytes) -> dict:
    """A snapshot's rows, read back from its Arrow bytes."""
    pa_ipc = pytest.importorskip("pyarrow.ipc")
    return pa_ipc.open_stream(ipc).read_all().to_pydict()


def _manifest(widget) -> list[dict]:
    return json.loads(widget.data_manifest)


def _sent(widget, content):
    """Deliver a browser message to the widget; return what it sends back."""
    replies = []
    widget.send = lambda msg, buffers=None: replies.append((msg, buffers))
    widget._on_frontend_msg(widget, content, [])
    return replies


class TestSnapshots:
    def test_a_changed_pandas_frame_gets_a_new_name_and_its_new_rows(self):
        pd = pytest.importorskip("pandas")
        pytest.importorskip("pyarrow")
        df = pd.DataFrame({"x": [1.0, 2.0], "y": [1.0, 2.0]})
        before = fj.dot(data=df, x="x", y="y")
        df.loc[0, "y"] = 99.0  # in place: same object
        after = fj.dot(data=df, x="x", y="y")

        assert after.table != before.table
        assert _rows(after._snapshot.ipc)["y"] == [99.0, 2.0]

    def test_a_changed_polars_frame_gets_a_new_name(self):
        pl = pytest.importorskip("polars")
        df = pl.DataFrame({"x": [1.0, 2.0], "y": [1.0, 2.0]})
        before = fj.dot(data=df, x="x", y="y")
        df.insert_column(2, pl.Series("z", [5, 6]))  # in place: same object
        after = fj.dot(data=df, x="x", y="y")

        assert after.table != before.table

    def test_a_mark_ships_the_rows_it_was_made_with(self):
        pd = pytest.importorskip("pandas")
        pytest.importorskip("pyarrow")
        df = pd.DataFrame({"x": [1.0, 2.0], "y": [1.0, 2.0]})
        mark = fj.dot(data=df, x="x", y="y")
        df.loc[0, "y"] = 99.0  # after the mark was made

        (name, table), = mark._collect_data().items()
        assert name == mark.table == table.name
        assert _rows(table.ipc)["y"] == [1.0, 2.0]


class TestBlob:
    def test_an_unconfirmed_table_travels_in_the_blob(self):
        pl = pytest.importorskip("polars")
        mark = fj.dot(data=pl.DataFrame({"x": [1.0], "y": [2.0]}), x="x", y="y")
        widget = make_widget(mark)

        (entry,) = _manifest(widget)
        assert entry["name"] == mark.table
        assert entry["hash"] == mark._snapshot.hash
        blob = widget.data_blob
        assert blob[entry["offset"]:entry["offset"] + entry["length"]] == mark._snapshot.ipc

    def test_a_confirmed_table_is_listed_without_bytes(self):
        pl = pytest.importorskip("polars")
        df = pl.DataFrame({"x": [1.0], "y": [2.0]})
        first = make_widget(fj.dot(data=df, x="x", y="y"))
        _sent(first, {"type": "fjader:loaded", "hashes": [_manifest(first)[0]["hash"]]})

        second = make_widget(fj.dot(data=df, x="x", y="y"))
        (entry,) = _manifest(second)
        assert "offset" not in entry and "length" not in entry
        assert second.data_blob == b""

    def test_changed_data_travels_even_after_a_confirmation(self):
        pl = pytest.importorskip("polars")
        df = pl.DataFrame({"x": [1.0], "y": [2.0]})
        first = make_widget(fj.dot(data=df, x="x", y="y"))
        _sent(first, {"type": "fjader:loaded", "hashes": [_manifest(first)[0]["hash"]]})

        changed = make_widget(fj.dot(data=df.with_columns(y=pl.lit(3.0)), x="x", y="y"))
        (entry,) = _manifest(changed)
        assert "offset" in entry and len(changed.data_blob) == entry["length"]

    def test_a_widget_never_confirmed_leaves_nothing_out(self):
        """Made but not shown (or a headless export): the next widget sends everything."""
        pl = pytest.importorskip("polars")
        df = pl.DataFrame({"x": [1.0], "y": [2.0]})
        make_widget(fj.dot(data=df, x="x", y="y"))
        again = make_widget(fj.dot(data=df, x="x", y="y"))
        assert "offset" in _manifest(again)[0]


class TestMessages:
    def test_a_request_is_answered_from_the_widgets_snapshot(self):
        pl = pytest.importorskip("polars")
        mark = fj.dot(data=pl.DataFrame({"x": [1.0], "y": [2.0]}), x="x", y="y")
        widget = make_widget(mark)
        wanted = {"name": mark.table, "hash": mark._snapshot.hash}

        ((msg, buffers),) = _sent(widget, {"type": "fjader:need", "id": "r1", "tables": [wanted]})
        assert msg == {"type": "fjader:tables", "id": "r1", "tables": [wanted], "missing": []}
        assert buffers == [mark._snapshot.ipc]

    def test_a_request_for_other_content_under_the_name_is_refused(self):
        pl = pytest.importorskip("polars")
        mark = fj.dot(data=pl.DataFrame({"x": [1.0], "y": [2.0]}), x="x", y="y")
        widget = make_widget(mark)

        ((msg, buffers),) = _sent(widget, {
            "type": "fjader:need",
            "id": "r2",
            "tables": [
                {"name": mark.table, "hash": "0" * 16},
                {"name": "_df_unknown", "hash": "1" * 16},
            ],
        })
        assert msg["tables"] == [] and buffers == []
        assert msg["missing"] == [mark.table, "_df_unknown"]

    def test_a_widget_confirms_only_its_own_tables(self):
        pl = pytest.importorskip("polars")
        mark = fj.dot(data=pl.DataFrame({"x": [1.0], "y": [2.0]}), x="x", y="y")
        widget = make_widget(mark)

        _sent(widget, {"type": "fjader:loaded", "hashes": [mark._snapshot.hash, "f" * 16]})
        assert _display._confirmed == {mark._snapshot.hash}

    def test_unknown_messages_are_ignored(self):
        pl = pytest.importorskip("polars")
        widget = make_widget(fj.dot(data=pl.DataFrame({"x": [1.0]}), x="x", y="x"))
        assert _sent(widget, {"type": "something-else"}) == []
        assert _sent(widget, "not a dict") == []
