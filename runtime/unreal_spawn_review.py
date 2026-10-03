"""Bounded PIE spawn review. Importable without Unreal for report regression tests."""
import math
import time


def assess_spawn_samples(starts, samples, duration=6, tolerance_cm=200, require_grounded=True):
    """Native centimetres, simulation seconds; never infer collision from a mesh flag."""
    report = dict(status='failed', expected_starts=starts, samples=samples, issues=[],
                  checks=['spawn_position', 'fall_distance'] + (['character_grounding'] if require_grounded else []))
    issues = report['issues']
    if not starts:
        issues.append('no_authored_player_start')
    if not samples:
        issues.append('no_player_pawn')
        return report
    first, last = samples[0], samples[-1]
    nearest = min(starts, key=lambda s: math.dist(s['position'], first['position'])) if starts else None
    if nearest:
        report['matched_start'] = nearest['id']
        report['initial_distance_cm'] = math.dist(nearest['position'], first['position'])
        if report['initial_distance_cm'] > tolerance_cm:
            issues.append('game_mode_ignored_player_start')
        if min(s['position'][2] for s in samples) < nearest['position'][2] - tolerance_cm:
            issues.append('fell_below_spawn')
    if last['time'] - first['time'] < duration - .05:
        issues.append('observation_incomplete')
    if len({s['pawn'] for s in samples}) != 1:
        issues.append('pawn_replaced_during_review')
    if require_grounded:
        tail = [s for s in samples if s['time'] >= last['time'] - 1]
        if any(s.get('grounded') is None for s in samples):
            issues.append('ground_check_requires_character')
        elif len(tail) < 2 or tail[-1]['time'] - tail[0]['time'] < .5 or not all(s['grounded'] and not s['falling'] for s in tail):
            issues.append('character_not_stably_grounded')
    report['status'] = 'failed' if issues else 'passed'
    return report


class SpawnReview:
    """Owns only the PIE session it starts. Caller polls from a Slate tick."""

    def __init__(self, starts, duration=6, tolerance_cm=200, require_grounded=True):
        import unreal
        self.ue = unreal
        self.levels = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
        self.editor = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem)
        self.starts, self.duration, self.tolerance = starts, duration, tolerance_cm
        self.require_grounded = require_grounded
        self.samples, self.settings_before = [], {}
        self.started_at = None
        self.owns_session = False
        self.result = None
        self.settings = None
        self.world_path = None

    def start(self):
        if self.levels.is_in_play_in_editor() or self.editor.get_game_world():
            return False  # Never take over or stop the user's play session.
        ue = self.ue
        # This editor-only class is not exported as unreal.LevelEditorPlaySettings
        # in every UE distribution. Resolve its reflected native class explicitly.
        self.settings = ue.get_default_object(ue.load_class(None, '/Script/UnrealEd.LevelEditorPlaySettings'))
        # UE 5.7 does not expose EPlayNetMode to Python. Preserve that setting
        # and check the resulting world's mode instead of guessing its value.
        values = dict(PlayNumberOfClients=1,
                      RunUnderOneProcess=True, bLaunchSeparateServer=False,
                      GameGetsMouseControl=False, AutoRecompileBlueprints=False)
        try:
            for key, value in values.items():
                self.settings_before[key] = self.settings.get_editor_property(key)
                self.settings.set_editor_property(key, value)
            # LevelEditorSubsystem requests the default PlayerStart, with no
            # camera-location override. This must exercise the real GameMode.
            self.levels.editor_request_begin_play()
            self.owns_session = True
            self.started_at = time.monotonic()
        except Exception:
            self.close()
            raise
        return True

    def close(self):
        if self.owns_session:
            self.levels.editor_request_end_play()
            self.owns_session = False
        if self.settings:
            for key, value in self.settings_before.items():
                self.settings.set_editor_property(key, value)
        self.settings_before.clear()

    def finish(self, extra_issue=None):
        self.result = assess_spawn_samples(self.starts, self.samples, self.duration, self.tolerance, self.require_grounded)
        if extra_issue:
            self.result['issues'].append(extra_issue)
            self.result['status'] = 'failed'
        self.result['world'] = self.world_path
        self.close()
        return self.result

    def poll(self):
        if self.result is not None:
            return self.result
        if self.started_at is None:
            raise RuntimeError('Start the spawn review before polling.')
        if time.monotonic() - self.started_at > 60:
            return self.finish('pie_review_timeout')
        world = self.editor.get_game_world()
        if not world:
            return self.finish('play_session_ended_early') if self.world_path else None
        self.world_path = world.get_path_name()
        ue = self.ue
        if not ue.SystemLibrary.is_standalone(world):
            return self.finish('standalone_play_mode_required')
        pawn = ue.GameplayStatics.get_player_pawn(world, 0)
        if not pawn:
            return self.finish('player_pawn_disappeared') if self.samples else None
        sim_time = ue.GameplayStatics.get_time_seconds(world)
        if self.samples and sim_time - self.samples[-1]['time'] < .2:
            return None
        position = pawn.get_actor_location()
        movement = pawn.get_component_by_class(ue.CharacterMovementComponent)
        sample = dict(time=sim_time, pawn=pawn.get_path_name(), position=[position.x, position.y, position.z],
                      grounded=movement.is_moving_on_ground() if movement else None,
                      falling=movement.is_falling() if movement else None)
        self.samples.append(sample)
        if len(self.samples) == 1:
            mode = ue.GameplayStatics.get_game_mode(world)
            self.game_mode = mode.get_class().get_path_name() if mode else None
        complete = sim_time - self.samples[0]['time'] >= self.duration
        wrong_spawn = min(math.dist(s['position'], self.samples[0]['position']) for s in self.starts) > self.tolerance
        if complete or wrong_spawn:
            result = self.finish()
            result['game_mode'] = self.game_mode
            return result
        return None
