import type { JoystickConfig, JoystickFile } from './index.js';

export function unrealJoystickFiles(c: JoystickConfig): JoystickFile[] {
  const p = 'Plugins/GripForgeJoystick/';
  const src=p+'Source/GripForgeJoystick/';
  return [{path:p+'GripForgeJoystick.uplugin',content:JSON.stringify({FileVersion:3,Version:1,VersionName:'1.0.0',FriendlyName:'GripForge Joystick',Description:'Independent touch/mouse movement and look sticks for an existing Pawn.',Category:'Input',CreatedBy:'GripForge',CanContainContent:false,Modules:[{Name:'GripForgeJoystick',Type:'Runtime',LoadingPhase:'Default'}]},null,2)},
  {path:src+'GripForgeJoystick.Build.cs',content:`using UnrealBuildTool;
public class GripForgeJoystick : ModuleRules {
    public GripForgeJoystick(ReadOnlyTargetRules Target) : base(Target) {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PublicDependencyModuleNames.AddRange(new string[]{"Core","CoreUObject","Engine","UMG"});
        PrivateDependencyModuleNames.AddRange(new string[]{"Slate","SlateCore","InputCore","ApplicationCore"});
    }
}
`},{path:src+'Private/GripForgeJoystickModule.cpp',content:`#include "Modules/ModuleManager.h"
IMPLEMENT_MODULE(FDefaultModuleImpl, GripForgeJoystick)
`},{path:src+'Public/GripForgeJoystickWidget.h',content:`#pragma once
#include "CoreMinimal.h"
#include "Blueprint/UserWidget.h"
#include "GripForgeJoystickWidget.generated.h"
class SGripForgeStick;

UCLASS()
class GRIPFORGEJOYSTICK_API UGripForgeJoystickWidget : public UUserWidget {
    GENERATED_BODY()
public:
    bool bDual = ${c.layout==='dual'?'true':'false'};
    float Radius = ${c.radius.toFixed(4)}f;
    float Deadzone = ${c.deadzone.toFixed(4)}f;
    FLinearColor Accent = FLinearColor(FColor::FromHex(TEXT("${c.accent.slice(1)}")));
    FVector2D GetMove() const;
    FVector2D GetLook() const;
    void ResetSticks();
    virtual void ReleaseSlateResources(bool bReleaseChildren) override;
protected:
    virtual TSharedRef<SWidget> RebuildWidget() override;
private:
    TSharedPtr<SGripForgeStick> MoveStick, LookStick;
};
`},{path:src+'Private/GripForgeJoystickWidget.cpp',content:`#include "GripForgeJoystickWidget.h"
#include "Widgets/SLeafWidget.h"
#include "Widgets/SOverlay.h"
#include "Widgets/Layout/SSafeZone.h"
#include "Widgets/Layout/SBox.h"
#include "Brushes/SlateRoundedBoxBrush.h"
#include "Rendering/DrawElements.h"
#include "Input/Reply.h"
#include "InputCoreTypes.h"

class SGripForgeStick : public SLeafWidget {
public:
    SLATE_BEGIN_ARGS(SGripForgeStick) : _Radius(72), _Deadzone(.15f), _Accent(FLinearColor::White) {}
        SLATE_ARGUMENT(float, Radius)
        SLATE_ARGUMENT(float, Deadzone)
        SLATE_ARGUMENT(FLinearColor, Accent)
    SLATE_END_ARGS()
    void Construct(const FArguments& Args) {
        Radius=Args._Radius; Deadzone=Args._Deadzone; Accent=Args._Accent;
        SetCanTick(false);
    }
    FVector2D Axis = FVector2D::ZeroVector;
    void Reset() { Owner=INDEX_NONE; OwnerUser=INDEX_NONE; Axis=Visual=FVector2D::ZeroVector; Invalidate(EInvalidateWidgetReason::Paint); }
    static FVector2D Radial(FVector2D Value, float Zone) {
        const double M=Value.Size();
        return M<=Zone || !FMath::IsFinite(M) ? FVector2D::ZeroVector : Value/M*FMath::Min(1.0,(M-Zone)/(1.0-Zone));
    }
    virtual FVector2D ComputeDesiredSize(float) const override { return FVector2D(Radius*2); }
    virtual int32 OnPaint(const FPaintArgs&, const FGeometry& G, const FSlateRect&, FSlateWindowElementList& Out, int32 Layer, const FWidgetStyle&, bool) const override {
        const float R=FMath::Min(G.GetLocalSize().X,G.GetLocalSize().Y)*.5f;
        const FVector2D C=G.GetLocalSize()*.5;
        FSlateDrawElement::MakeBox(Out,Layer,G.ToPaintGeometry(FVector2D(R*2),FSlateLayoutTransform(C-FVector2D(R))),&Circle,ESlateDrawEffect::None,FLinearColor(.06f,.08f,.11f,.72f));
        const float TR=R*.28f;
        FSlateDrawElement::MakeBox(Out,Layer+1,G.ToPaintGeometry(FVector2D(TR*2),FSlateLayoutTransform(C+Visual*R*.65f-FVector2D(TR))),&Circle,ESlateDrawEffect::None,Accent);
        return Layer+1;
    }
    virtual FReply OnMouseButtonDown(const FGeometry& G,const FPointerEvent& E) override { return E.GetEffectingButton()==EKeys::LeftMouseButton ? Begin(G,E) : FReply::Unhandled(); }
    virtual FReply OnMouseMove(const FGeometry& G,const FPointerEvent& E) override { return Move(G,E); }
    virtual FReply OnMouseButtonUp(const FGeometry&,const FPointerEvent& E) override { return E.GetEffectingButton()==EKeys::LeftMouseButton ? End(E) : FReply::Unhandled(); }
    virtual FReply OnTouchStarted(const FGeometry& G,const FPointerEvent& E) override { return Begin(G,E); }
    virtual FReply OnTouchMoved(const FGeometry& G,const FPointerEvent& E) override { return Move(G,E); }
    virtual FReply OnTouchEnded(const FGeometry&,const FPointerEvent& E) override { return End(E); }
    virtual void OnMouseCaptureLost(const FCaptureLostEvent&) override { Reset(); }
private:
    int32 Owner=INDEX_NONE, OwnerUser=INDEX_NONE;
    float Radius=72, Deadzone=.15f;
    FVector2D Visual=FVector2D::ZeroVector;
    FLinearColor Accent;
    const FSlateRoundedBoxBrush Circle{FLinearColor::White,1000.f};
    bool Owns(const FPointerEvent& E) const { return Owner==(int32)E.GetPointerIndex() && OwnerUser==(int32)E.GetUserIndex(); }
    void Update(const FGeometry& G,const FPointerEvent& E) {
        const double Travel=FMath::Min(G.GetLocalSize().X,G.GetLocalSize().Y)*.325;
        if(Travel<=0){Reset();return;}
        const FVector2D Raw=(G.AbsoluteToLocal(E.GetScreenSpacePosition())-G.GetLocalSize()*.5)/Travel;
        Visual=Raw/FMath::Max(1.0,Raw.Size());
        Axis=Radial(FVector2D(Raw.X,-Raw.Y),Deadzone);
        Invalidate(EInvalidateWidgetReason::Paint);
    }
    FReply Begin(const FGeometry& G,const FPointerEvent& E) {
        if(Owner!=INDEX_NONE)return FReply::Handled();
        Owner=E.GetPointerIndex(); OwnerUser=E.GetUserIndex(); Update(G,E);
        return FReply::Handled().CaptureMouse(SharedThis(this));
    }
    FReply Move(const FGeometry& G,const FPointerEvent& E) { if(!Owns(E))return FReply::Unhandled(); Update(G,E); return FReply::Handled(); }
    FReply End(const FPointerEvent& E) { if(!Owns(E))return FReply::Unhandled(); Reset(); return FReply::Handled().ReleaseMouseCapture(); }
};

TSharedRef<SWidget> UGripForgeJoystickWidget::RebuildWidget() {
    auto Overlay=SNew(SOverlay).Visibility(EVisibility::SelfHitTestInvisible);
    Overlay->AddSlot().HAlign(HAlign_Left).VAlign(VAlign_Bottom).Padding(24)[
        SAssignNew(MoveStick,SGripForgeStick).Radius(Radius).Deadzone(Deadzone).Accent(Accent)];
    if(bDual) Overlay->AddSlot().HAlign(HAlign_Right).VAlign(VAlign_Bottom).Padding(24)[
        SAssignNew(LookStick,SGripForgeStick).Radius(Radius).Deadzone(Deadzone).Accent(Accent)];
    return SNew(SSafeZone).Visibility(EVisibility::SelfHitTestInvisible)[Overlay];
}
FVector2D UGripForgeJoystickWidget::GetMove() const { return MoveStick.IsValid()?MoveStick->Axis:FVector2D::ZeroVector; }
FVector2D UGripForgeJoystickWidget::GetLook() const { return LookStick.IsValid()?LookStick->Axis:FVector2D::ZeroVector; }
void UGripForgeJoystickWidget::ResetSticks(){if(MoveStick)MoveStick->Reset();if(LookStick)LookStick->Reset();}
void UGripForgeJoystickWidget::ReleaseSlateResources(bool bReleaseChildren){ResetSticks();Super::ReleaseSlateResources(bReleaseChildren);MoveStick.Reset();LookStick.Reset();}
`},{path:src+'Public/GripForgeJoystickComponent.h',content:`#pragma once
#include "CoreMinimal.h"
#include "Components/ActorComponent.h"
#include "GripForgeJoystickComponent.generated.h"
class UGripForgeJoystickWidget;
class APlayerController;

UCLASS(ClassGroup=(Input), meta=(BlueprintSpawnableComponent))
class GRIPFORGEJOYSTICK_API UGripForgeJoystickComponent : public UActorComponent {
    GENERATED_BODY()
public:
    UGripForgeJoystickComponent();
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Joystick") bool bDual = ${c.layout==='dual'?'true':'false'};
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Joystick",meta=(ClampMin="32",ClampMax="160")) float Radius = ${c.radius.toFixed(4)}f;
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Joystick",meta=(ClampMin="0",ClampMax="0.5")) float Deadzone = ${c.deadzone.toFixed(4)}f;
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Joystick") FLinearColor Accent = FLinearColor(FColor::FromHex(TEXT("${c.accent.slice(1)}")));
    // Turn these off if your existing motor reads GetMove/GetLook itself.
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Joystick") bool bDriveMovement = true;
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Joystick") bool bDriveLook = true;
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Joystick") float LookDegreesPerSecond = 120.f;
    UFUNCTION(BlueprintPure, Category="Joystick") FVector2D GetMove() const;
    UFUNCTION(BlueprintPure, Category="Joystick") FVector2D GetLook() const;
    UFUNCTION(BlueprintCallable, Category="Joystick") void ResetInput();
    virtual void Deactivate() override;
    virtual void TickComponent(float Delta, ELevelTick TickType, FActorComponentTickFunction* ThisTick) override;
protected:
    virtual void BeginPlay() override;
    virtual void EndPlay(const EEndPlayReason::Type Reason) override;
private:
    UPROPERTY(Transient) TObjectPtr<UGripForgeJoystickWidget> Widget;
    TWeakObjectPtr<APlayerController> Controller;
    FDelegateHandle FocusHandle, BackgroundHandle;
    void RemoveWidget();
};
`},{path:src+'Private/GripForgeJoystickComponent.cpp',content:`#include "GripForgeJoystickComponent.h"
#include "GripForgeJoystickWidget.h"
#include "GameFramework/Pawn.h"
#include "GameFramework/PlayerController.h"
#include "GameFramework/PawnMovementComponent.h"
#include "Misc/CoreDelegates.h"
#include "Math/RotationMatrix.h"

UGripForgeJoystickComponent::UGripForgeJoystickComponent(){bAutoActivate=true;PrimaryComponentTick.bCanEverTick=true;PrimaryComponentTick.TickGroup=TG_PrePhysics;}
void UGripForgeJoystickComponent::BeginPlay(){
    Super::BeginPlay();
    FocusHandle=FCoreDelegates::ApplicationWillDeactivateDelegate.AddUObject(this,&UGripForgeJoystickComponent::ResetInput);
    BackgroundHandle=FCoreDelegates::ApplicationWillEnterBackgroundDelegate.AddUObject(this,&UGripForgeJoystickComponent::ResetInput);
    if(auto* Pawn=Cast<APawn>(GetOwner()))if(auto* Motor=Pawn->GetMovementComponent())Motor->AddTickPrerequisiteComponent(this);
}
void UGripForgeJoystickComponent::TickComponent(float Delta,ELevelTick TickType,FActorComponentTickFunction* ThisTick){
    Super::TickComponent(Delta,TickType,ThisTick);
    auto* Pawn=Cast<APawn>(GetOwner());
    auto* PC=Pawn?Cast<APlayerController>(Pawn->GetController()):nullptr;
    if(!PC || !Pawn->IsLocallyControlled() || !PC->IsLocalController()){RemoveWidget();return;}
    // Possession may occur AFTER BeginPlay. Recreate on local controller changes.
    if(Controller.Get()!=PC){RemoveWidget();Controller=PC;}
    if(!Widget){
        Widget=CreateWidget<UGripForgeJoystickWidget>(PC);
        if(!Widget)return;
        Widget->bDual=bDual;Widget->Radius=FMath::Clamp(Radius,32.f,160.f);Widget->Deadzone=FMath::Clamp(Deadzone,0.f,.5f);Widget->Accent=Accent;
        Widget->SetVisibility(ESlateVisibility::SelfHitTestInvisible);
        Widget->AddToPlayerScreen(20);
    }
    if(PC->IsPaused()){ResetInput();return;}
    const FVector2D Move=GetMove(),Look=GetLook();
    if(bDriveMovement && !PC->IsMoveInputIgnored()){
        const FRotationMatrix Basis(FRotator(0,PC->GetControlRotation().Yaw,0));
        Pawn->AddMovementInput(Basis.GetUnitAxis(EAxis::X),Move.Y);
        Pawn->AddMovementInput(Basis.GetUnitAxis(EAxis::Y),Move.X);
    }
    if(bDriveLook && !PC->IsLookInputIgnored()){
        // InputYaw/PitchScale belong to the game's controller, just as for other axes.
        Pawn->AddControllerYawInput(Look.X*LookDegreesPerSecond*Delta);
        Pawn->AddControllerPitchInput(-Look.Y*LookDegreesPerSecond*Delta);
    }
}
FVector2D UGripForgeJoystickComponent::GetMove() const {return IsActive()&&Widget?Widget->GetMove():FVector2D::ZeroVector;}
FVector2D UGripForgeJoystickComponent::GetLook() const {return IsActive()&&Widget?Widget->GetLook():FVector2D::ZeroVector;}
void UGripForgeJoystickComponent::ResetInput(){if(Widget)Widget->ResetSticks();}
void UGripForgeJoystickComponent::Deactivate(){RemoveWidget();Super::Deactivate();}
void UGripForgeJoystickComponent::RemoveWidget(){if(Widget){Widget->ResetSticks();Widget->RemoveFromParent();Widget=nullptr;}Controller.Reset();}
void UGripForgeJoystickComponent::EndPlay(const EEndPlayReason::Type Reason){
    RemoveWidget();FCoreDelegates::ApplicationWillDeactivateDelegate.Remove(FocusHandle);FCoreDelegates::ApplicationWillEnterBackgroundDelegate.Remove(BackgroundHandle);
    if(auto* Pawn=Cast<APawn>(GetOwner()))if(auto* Motor=Pawn->GetMovementComponent())Motor->RemoveTickPrerequisiteComponent(this);
    Super::EndPlay(Reason);
}
`},{path:'README.md',content:`# GripForge joystick · Unreal Engine 5

1. Copy Plugins/GripForgeJoystick into the project (not Engine). Compile the
   runtime plugin with your UE version/toolchain, then reopen the editor. A
   Blueprint-only project can add a C++ class first to enable project builds.
2. Enable GripForge Joystick in Plugins if needed. On the actual possessed Pawn
   Blueprint, Add Component → GripForge Joystick. It waits for local possession.
3. Press Play. Left stick feeds your Pawn's existing AddMovementInput; right
   stick feeds controller yaw/pitch. CharacterMovement still owns collision,
   gravity, acceleration and network prediction. No GameMode replacement.

Mouse and touch work directly through Slate; Use Mouse for Touch is not required.
For a desktop mouse test, use Game and UI input mode and show the cursor in your
PlayerController. Keep the game viewport focused. The plugin deliberately does
not change your game's input mode/cursor. Native touch works in Game Only mode.
Remove/disable the previous virtual joystick to avoid overlapping controls.

For a custom motor disable Drive Movement/Drive Look and read Get Move/Get Look
from the component every tick. Axes: X right, Y forward/up; magnitude <= 1. Apply
look deltaTime once. Existing gamepad/keyboard actions are not overwritten.
Deadzone, radius, color and dual-stick layout are set before the UI is created.
The overlay respects Slate DPI/safe zones. Release, capture loss, application
focus loss, losing possession and EndPlay reset the axes. Use Reset Input when
opening your own modal menus. One component per locally controlled pawn.

This is a source plugin, not a precompiled binary for every UE release. Compile
for the target UE/platform and test in your real project before packaging.
`}];
}
