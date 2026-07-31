/// Minimal Hybrid Logical Clock (SDD §2.1/§2.2): gives every outbox event a
/// timestamp that is monotonically increasing *on this device* even across
/// clock adjustments, and is used for causal ordering within a sync batch
/// (never for cross-device conflict resolution of financial truth — see
/// docs/SDD.md §2.3, that's handled by server-side rules per scenario).
class HybridLogicalClock {
  HybridLogicalClock(this.deviceId);

  final String deviceId;
  int _lastPhysical = 0;
  int _counter = 0;

  String next() {
    final now = DateTime.now().millisecondsSinceEpoch;
    if (now > _lastPhysical) {
      _lastPhysical = now;
      _counter = 0;
    } else {
      _counter++;
    }
    return '$_lastPhysical-$_counter-$deviceId';
  }
}
